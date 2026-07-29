import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  safeValidateUIMessages,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  type Channel,
  type ChannelCors,
  type ChannelEvents,
  type ChannelSessionOps,
  defineChannel,
  GET,
  POST,
  type RouteHandlerArgs,
} from "eve/channels";
import { type AuthFn, routeAuth } from "eve/channels/auth";
import type { HandleMessageStreamEvent } from "eve/client";

type AiSdkAuthContext = Exclude<Awaited<ReturnType<AuthFn<Request>>>, null | undefined>;

export type AiSdkEventContext = ChannelSessionOps;
export type AiSdkChannelEvents = ChannelEvents<AiSdkEventContext>;

export type AiSdkHandle = {
  readonly caller: AiSdkAuthContext;
  readonly chatId: string;
  readonly request: Request;
};

export type AiSdkMessageContext = {
  readonly aiSdk: AiSdkHandle;
};

export type AiSdkMessageResult = {
  readonly auth: AiSdkAuthContext | null;
  readonly context?: readonly string[];
} | null;

export type AiSdkMessageResultOrPromise = AiSdkMessageResult | Promise<AiSdkMessageResult>;

export type AiSdkChannelInput = {
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly cors?: ChannelCors;
  readonly events?: AiSdkChannelEvents;
  readonly onMessage?: (
    context: AiSdkMessageContext,
    message: string,
  ) => AiSdkMessageResultOrPromise;
};

export interface AiSdkChannel extends Channel {}

type EveEvent = HandleMessageStreamEvent;
type RequestedAction = Extract<EveEvent, { type: "actions.requested" }>["data"]["actions"][number];

type StreamState = {
  readonly textParts: Set<string>;
  finishReason: FinishReason;
  isFinished: boolean;
  isStarted: boolean;
};

type ChatRequest = {
  readonly id: string;
  readonly message: string;
};

export function defaultAiSdkAuth(context: AiSdkMessageContext): AiSdkAuthContext {
  return context.aiSdk.caller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function getErrorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Eve stream failed.";
}

async function resolveOnMessage(
  input: AiSdkChannelInput,
  request: Request,
  chat: ChatRequest,
  caller: AiSdkAuthContext,
): Promise<AiSdkMessageResult | Response> {
  const context = {
    aiSdk: {
      caller,
      chatId: chat.id,
      request,
    },
  };

  if (!input.onMessage) {
    return { auth: defaultAiSdkAuth(context) };
  }

  try {
    return await input.onMessage(context, chat.message);
  } catch (error) {
    console.error("AI SDK onMessage handler failed.", error);
    return Response.json({ error: "onMessage handler failed." }, { status: 500 });
  }
}

function createSendPayload(message: string, context?: readonly string[]) {
  if (!context) {
    return message;
  }
  return { message, context };
}

function getToolName(action: RequestedAction): string {
  switch (action.kind) {
    case "tool-call":
      return action.toolName;
    case "load-skill":
      return "eve:load-skill";
    case "subagent-call":
      return `eve:subagent:${action.subagentName}`;
    case "remote-agent-call":
      return `eve:subagent:${action.remoteAgentName}`;
  }
}

function textPartId(data: { readonly stepIndex: number; readonly turnId: string }): string {
  return `${data.turnId}:${data.stepIndex}:text`;
}

function getTurnId(event: EveEvent): string | undefined {
  if ("data" in event && "turnId" in event.data) {
    return event.data.turnId;
  }
}

function isTurnFinished(event: EveEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.cancelled" ||
    event.type === "turn.failed"
  );
}

function* startMessage(state: StreamState, messageId: string): Generator<UIMessageChunk> {
  if (!state.isStarted) {
    state.isStarted = true;
    yield { type: "start", messageId };
  }
}

function* closeTextParts(state: StreamState): Generator<UIMessageChunk> {
  for (const id of state.textParts) {
    yield { type: "text-end", id };
  }
  state.textParts.clear();
}

function* transformEveEvent(event: EveEvent, state: StreamState): Generator<UIMessageChunk> {
  switch (event.type) {
    case "turn.started":
      yield* startMessage(state, event.data.turnId);
      break;

    case "message.appended": {
      yield* startMessage(state, event.data.turnId);
      const id = textPartId(event.data);
      if (!state.textParts.has(id)) {
        state.textParts.add(id);
        yield { type: "text-start", id };
      }
      yield { type: "text-delta", id, delta: event.data.messageDelta };
      break;
    }

    case "message.completed": {
      state.finishReason = event.data.finishReason;
      yield* startMessage(state, event.data.turnId);
      const id = textPartId(event.data);
      if (!state.textParts.delete(id)) {
        yield { type: "text-start", id };
        if (event.data.message) {
          yield { type: "text-delta", id, delta: event.data.message };
        }
      }
      yield { type: "text-end", id };
      break;
    }

    case "actions.requested":
      yield* startMessage(state, event.data.turnId);
      for (const action of event.data.actions) {
        yield {
          type: "tool-input-available",
          dynamic: true,
          toolCallId: action.callId,
          toolName: getToolName(action),
          input: action.input,
        };
      }
      break;

    case "action.result":
      if (event.data.status === "rejected") {
        yield { type: "tool-output-denied", toolCallId: event.data.result.callId };
        break;
      }
      if (event.data.status === "failed") {
        yield {
          type: "tool-output-error",
          dynamic: true,
          toolCallId: event.data.result.callId,
          errorText: event.data.error?.message ?? "Eve tool execution failed.",
        };
        break;
      }
      yield {
        type: "tool-output-available",
        dynamic: true,
        toolCallId: event.data.result.callId,
        output: event.data.result.output,
      };
      break;

    case "step.completed":
      state.finishReason = event.data.finishReason;
      break;

    case "turn.completed":
      if (state.isFinished) {
        break;
      }
      yield* closeTextParts(state);
      state.isFinished = true;
      yield { type: "finish", finishReason: state.finishReason };
      break;

    case "turn.cancelled":
      yield* closeTextParts(state);
      state.isFinished = true;
      yield { type: "abort", reason: "Eve turn cancelled." };
      break;

    case "step.failed":
    case "turn.failed":
    case "session.failed":
      if (state.isFinished) {
        break;
      }
      yield* closeTextParts(state);
      state.isFinished = true;
      yield { type: "error", errorText: event.data.message };
      yield { type: "finish", finishReason: "error" };
      break;
  }
}

async function* readEveEvents(events: ReadableStream<EveEvent>): AsyncGenerator<EveEvent> {
  const reader = events.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function* transformEveEvents(
  events: ReadableStream<EveEvent>,
  turnId: string,
): AsyncGenerator<UIMessageChunk> {
  const state: StreamState = {
    finishReason: "other",
    textParts: new Set(),
    isFinished: false,
    isStarted: false,
  };

  let isCurrentTurn = false;
  for await (const event of readEveEvents(events)) {
    if (!isCurrentTurn) {
      isCurrentTurn = getTurnId(event) === turnId;
    }
    if (!isCurrentTurn) {
      continue;
    }
    yield* transformEveEvent(event, state);
    if (state.isFinished) {
      return;
    }
  }

  yield* closeTextParts(state);
}

function toUIMessageStreamResponse(events: ReadableStream<EveEvent>, turnId: string): Response {
  const stream = createUIMessageStream({
    async execute({ writer }) {
      for await (const chunk of transformEveEvents(events, turnId)) {
        writer.write(chunk);
      }
    },
    onError: getErrorText,
  });

  return createUIMessageStreamResponse({ stream });
}

async function readChatRequest(request: Request): Promise<ChatRequest | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (!isRecord(body) || typeof body.id !== "string" || !body.id) {
    return badRequest("Expected a non-empty AI SDK chat id.");
  }

  const result = await safeValidateUIMessages({ messages: body.messages });
  if (!result.success) {
    return badRequest("Invalid AI SDK messages.");
  }

  const message = result.data.at(-1);
  if (message?.role !== "user") {
    return badRequest("Expected a user message.");
  }

  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  if (!text.trim()) {
    return badRequest("The user message is empty.");
  }

  return { id: body.id, message: text };
}

async function findTurnId(
  events: ReadableStream<EveEvent>,
  waitForTurn: boolean,
): Promise<string | undefined> {
  for await (const event of readEveEvents(events)) {
    const turnId = getTurnId(event);
    if (turnId) {
      return turnId;
    }
    if (!waitForTurn && event.type === "session.waiting") {
      return;
    }
  }
}

async function getLatestEvent(events: ReadableStream<EveEvent>): Promise<EveEvent | undefined> {
  for await (const event of readEveEvents(events)) {
    return event;
  }
}

async function readHistory(
  events: ReadableStream<EveEvent>,
  activeTurnId?: string,
  completedTurnId?: string,
): Promise<UIMessage[]> {
  const assistants = new Map<string, UIMessage>();
  const messages: UIMessage[] = [];

  for await (const event of readEveEvents(events)) {
    if (event.type === "message.received") {
      messages.push({
        id: `${event.data.turnId}:user`,
        role: "user",
        parts: [{ type: "text", text: event.data.message }],
      });
      if (event.data.turnId === activeTurnId) {
        return messages;
      }
    }

    if (event.type === "message.completed" && event.data.message) {
      let message = assistants.get(event.data.turnId);
      if (!message) {
        message = { id: event.data.turnId, role: "assistant", parts: [] };
        assistants.set(event.data.turnId, message);
        messages.push(message);
      }
      message.parts.push({ type: "text", text: event.data.message });
    }

    if (getTurnId(event) === completedTurnId && isTurnFinished(event)) {
      return messages;
    }
  }

  return messages;
}

export function aiSdkChannel(input: AiSdkChannelInput): AiSdkChannel {
  const auth = input.auth;

  return defineChannel({
    cors: input.cors ?? false,
    events: input.events ?? {},
    kindHint: "ai-sdk",
    routes: [
      POST("/eve/web", async (request: Request, { send }: RouteHandlerArgs) => {
        const authContext = await routeAuth(request, auth);
        if (authContext instanceof Response) {
          return authContext;
        }

        const chat = await readChatRequest(request);
        if (chat instanceof Response) {
          return chat;
        }

        const messageResult = await resolveOnMessage(input, request, chat, authContext);
        if (messageResult instanceof Response) {
          return messageResult;
        }
        if (!messageResult) {
          return new Response(null, { status: 204 });
        }

        const session = await send(createSendPayload(chat.message, messageResult.context), {
          auth: messageResult.auth,
          continuationToken: chat.id,
        });
        const turnId = await findTurnId(await session.getEventStream({ startIndex: -1 }), true);
        if (!turnId) {
          return Response.json({ error: "Eve turn did not start." }, { status: 500 });
        }
        const events = await session.getEventStream();

        return toUIMessageStreamResponse(events, turnId);
      }),
      GET(
        "/eve/web/:id",
        async (
          request: Request,
          { getSession, params, resolveActiveSession }: RouteHandlerArgs,
        ) => {
          const authContext = await routeAuth(request, auth);
          if (authContext instanceof Response) {
            return authContext;
          }

          const id = params.id;
          if (!id) {
            return badRequest("Missing chat id.");
          }

          const activeSession = await resolveActiveSession({ continuationToken: id });
          if (!activeSession) {
            return Response.json([]);
          }

          const session = getSession(activeSession.sessionId);
          const latest = await getLatestEvent(await session.getEventStream({ startIndex: -1 }));
          if (!latest) {
            return Response.json([]);
          }

          let activeTurnId: string | undefined;
          let completedTurnId: string | undefined;
          if (!isTurnFinished(latest)) {
            activeTurnId = getTurnId(latest);
          }
          if (latest.type === "session.waiting") {
            const previous = await getLatestEvent(await session.getEventStream({ startIndex: -2 }));
            if (previous) {
              completedTurnId = getTurnId(previous);
            }
          }
          return Response.json(
            await readHistory(await session.getEventStream(), activeTurnId, completedTurnId),
          );
        },
      ),
      GET(
        "/eve/web/:id/stream",
        async (
          request: Request,
          { getSession, params, resolveActiveSession }: RouteHandlerArgs,
        ) => {
          const authContext = await routeAuth(request, auth);
          if (authContext instanceof Response) {
            return authContext;
          }

          const id = params.id;
          if (!id) {
            return badRequest("Missing chat id.");
          }

          const activeSession = await resolveActiveSession({ continuationToken: id });
          if (!activeSession) {
            return new Response(null, { status: 204 });
          }

          const session = getSession(activeSession.sessionId);
          const turnId = await findTurnId(await session.getEventStream({ startIndex: -1 }), false);
          if (!turnId) {
            return new Response(null, { status: 204 });
          }

          return toUIMessageStreamResponse(await session.getEventStream(), turnId);
        },
      ),
    ],
  });
}
