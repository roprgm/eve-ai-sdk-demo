import type { RouteHandlerArgs } from "eve/channels";
import { none } from "eve/channels/auth";
import type { HandleMessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";

import { aiSdkChannel } from "../lib/ai-sdk-channel";

type EveEvent = HandleMessageStreamEvent;

const channel = aiSdkChannel({ auth: [none()] });
const turn = { sequence: 1, turnId: "turn-1" } as const;
const step = { ...turn, stepIndex: 0 } as const;

describe("AI SDK channel", () => {
  it("maps an Eve message lifecycle", async () => {
    const { chunks } = await runChannel([
      { type: "turn.started", data: turn },
      {
        type: "message.appended",
        data: { ...step, messageDelta: "Hello", messageSoFar: "Hello" },
      },
      {
        type: "message.completed",
        data: { ...step, finishReason: "stop", message: "Hello" },
      },
      { type: "turn.completed", data: turn },
    ]);

    expect(chunks).toEqual([
      { type: "start", messageId: "turn-1" },
      { type: "text-start", id: "turn-1:0:text" },
      { type: "text-delta", id: "turn-1:0:text", delta: "Hello" },
      { type: "text-end", id: "turn-1:0:text" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("forwards only message deltas", async () => {
    const { chunks } = await runChannel([
      {
        type: "message.appended",
        data: { ...step, messageDelta: "Hel", messageSoFar: "Hel" },
      },
      {
        type: "message.appended",
        data: { ...step, messageDelta: "lo", messageSoFar: "Hello" },
      },
      {
        type: "message.completed",
        data: { ...step, finishReason: "stop", message: "Hello" },
      },
    ]);

    expect(chunks).toEqual([
      { type: "start", messageId: "turn-1" },
      { type: "text-start", id: "turn-1:0:text" },
      { type: "text-delta", id: "turn-1:0:text", delta: "Hel" },
      { type: "text-delta", id: "turn-1:0:text", delta: "lo" },
      { type: "text-end", id: "turn-1:0:text" },
    ]);
  });

  it("maps tool calls and results", async () => {
    const { chunks } = await runChannel([
      {
        type: "actions.requested",
        data: {
          ...step,
          actions: [
            {
              kind: "tool-call",
              callId: "call-1",
              toolName: "weather",
              input: { city: "Tallinn" },
            },
          ],
        },
      },
      {
        type: "action.result",
        data: {
          ...step,
          status: "completed",
          result: {
            kind: "tool-result",
            callId: "call-1",
            toolName: "weather",
            output: { temperature: 18 },
          },
        },
      },
    ]);

    expect(chunks).toEqual([
      { type: "start", messageId: "turn-1" },
      {
        type: "tool-input-available",
        dynamic: true,
        toolCallId: "call-1",
        toolName: "weather",
        input: { city: "Tallinn" },
      },
      {
        type: "tool-output-available",
        dynamic: true,
        toolCallId: "call-1",
        output: { temperature: 18 },
      },
    ]);
  });

  it("maps failures once", async () => {
    const { chunks } = await runChannel([
      { type: "turn.failed", data: { ...turn, code: "MODEL_ERROR", message: "Failed" } },
      {
        type: "session.failed",
        data: { sessionId: "session-1", code: "FAILED", message: "Failed" },
      },
    ]);

    expect(chunks).toEqual([
      { type: "error", errorText: "Failed" },
      { type: "finish", finishReason: "error" },
    ]);
  });

  it("closes a persistent Eve stream when the turn ends", async () => {
    const result = await runChannel(
      [
        { type: "turn.started", data: turn },
        { type: "turn.completed", data: turn },
      ],
      { keepOpen: true },
    );

    expect(result.cancel).toHaveBeenCalledTimes(2);
  });

  it("sends only the latest user message using the chat id", async () => {
    const result = await runChannel([{ type: "turn.started", data: turn }], { message: "New" });

    expect(result.status).toBe(200);
    expect(result.protocol).toBe("v1");
    expect(result.contentType).toContain("text/event-stream");
    expect(result.send).toHaveBeenCalledWith("New", {
      auth: expect.any(Object),
      continuationToken: "chat-1",
    });
    expect(result.getEventStream).toHaveBeenNthCalledWith(1, { startIndex: -1 });
    expect(result.getEventStream).toHaveBeenNthCalledWith(2);
  });

  it("applies onMessage auth and context before dispatch", async () => {
    const onMessage = vi.fn(() => ({
      auth: null,
      context: ["Trusted application context."],
    }));
    const configuredChannel = aiSdkChannel({
      auth: [none()],
      onMessage,
    });

    const result = await runChannel([{ type: "turn.started", data: turn }], {
      channel: configuredChannel,
      message: "New",
    });

    expect(onMessage).toHaveBeenCalledWith(
      {
        aiSdk: {
          caller: expect.any(Object),
          chatId: "chat-1",
          request: expect.any(Request),
        },
      },
      "New",
    );
    expect(result.send).toHaveBeenCalledWith(
      {
        message: "New",
        context: ["Trusted application context."],
      },
      {
        auth: null,
        continuationToken: "chat-1",
      },
    );
  });

  it("lets onMessage skip dispatch", async () => {
    const configuredChannel = aiSdkChannel({
      auth: [none()],
      onMessage: () => null,
    });

    const result = await runChannel([], { channel: configuredChannel });

    expect(result.status).toBe(204);
    expect(result.send).not.toHaveBeenCalled();
  });

  it("resumes the current turn through the standard AI SDK endpoint", async () => {
    const getEventStream = vi.fn(async () =>
      readableEvents([{ type: "turn.started", data: turn }], false, vi.fn()),
    );
    const getSession = vi.fn(() => ({ getEventStream }));
    const resolveActiveSession = vi.fn(async () => ({ sessionId: "session-1" }));
    const route = channel.routes[2];
    if (!route || !("method" in route)) {
      throw new Error("Missing resume route.");
    }

    const request = new Request("http://localhost/eve/web/chat-1/stream");
    const response = await route.handler(request, {
      getSession,
      params: { id: "chat-1" },
      resolveActiveSession,
    } as unknown as RouteHandlerArgs);
    if (!(response instanceof Response)) {
      throw new Error("Expected an HTTP response.");
    }

    const result = await readChunks(response);
    expect(resolveActiveSession).toHaveBeenCalledWith({ continuationToken: "chat-1" });
    expect(getSession).toHaveBeenCalledWith("session-1");
    expect(getEventStream).toHaveBeenNthCalledWith(1, { startIndex: -1 });
    expect(getEventStream).toHaveBeenNthCalledWith(2);
    expect(result.chunks).toEqual([{ type: "start", messageId: "turn-1" }]);
  });

  it("restores completed messages from Eve history", async () => {
    const cancel = vi.fn();
    const getEventStream = vi
      .fn()
      .mockResolvedValueOnce(
        readableEvents(
          [
            {
              type: "session.waiting",
              data: { continuationToken: "chat-1", wait: "next-user-message" },
            },
          ],
          false,
          vi.fn(),
        ),
      )
      .mockResolvedValueOnce(
        readableEvents([{ type: "turn.completed", data: turn }], true, vi.fn()),
      )
      .mockResolvedValueOnce(
        readableEvents(
          [
            { type: "message.received", data: { ...turn, message: "Hello" } },
            {
              type: "message.completed",
              data: { ...step, finishReason: "stop", message: "Hi" },
            },
            { type: "turn.completed", data: turn },
          ],
          true,
          cancel,
        ),
      );
    const route = channel.routes[1];
    if (!route || !("method" in route)) {
      throw new Error("Missing history route.");
    }

    const response = await route.handler(new Request("http://localhost/eve/web/chat-1"), {
      getSession: () => ({ getEventStream }),
      params: { id: "chat-1" },
      resolveActiveSession: async () => ({ sessionId: "session-1" }),
    } as unknown as RouteHandlerArgs);
    if (!(response instanceof Response)) {
      throw new Error("Expected an HTTP response.");
    }

    expect(await response.json()).toEqual([
      { id: "turn-1:user", role: "user", parts: [{ type: "text", text: "Hello" }] },
      { id: "turn-1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
    ]);
    expect(getEventStream).toHaveBeenNthCalledWith(2, { startIndex: -2 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("loads history through the active user message without waiting", async () => {
    const activeTurn = { sequence: 2, turnId: "turn-2" } as const;
    const getEventStream = vi
      .fn()
      .mockResolvedValueOnce(
        readableEvents(
          [
            {
              type: "message.appended",
              data: { ...activeTurn, stepIndex: 0, messageDelta: "W", messageSoFar: "W" },
            },
          ],
          false,
          vi.fn(),
        ),
      )
      .mockResolvedValueOnce(
        readableEvents(
          [
            { type: "message.received", data: { ...turn, message: "Hello" } },
            {
              type: "message.completed",
              data: { ...step, finishReason: "stop", message: "Hi" },
            },
            { type: "message.received", data: { ...activeTurn, message: "Weather?" } },
          ],
          true,
          vi.fn(),
        ),
      );
    const route = channel.routes[1];
    if (!route || !("method" in route)) {
      throw new Error("Missing history route.");
    }

    const response = await route.handler(new Request("http://localhost/eve/web/chat-1"), {
      getSession: () => ({ getEventStream }),
      params: { id: "chat-1" },
      resolveActiveSession: async () => ({ sessionId: "session-1" }),
    } as unknown as RouteHandlerArgs);
    if (!(response instanceof Response)) {
      throw new Error("Expected an HTTP response.");
    }

    expect(await response.json()).toEqual([
      { id: "turn-1:user", role: "user", parts: [{ type: "text", text: "Hello" }] },
      { id: "turn-1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
      { id: "turn-2:user", role: "user", parts: [{ type: "text", text: "Weather?" }] },
    ]);
  });
});

async function runChannel(
  events: readonly EveEvent[],
  options: {
    readonly channel?: typeof channel;
    readonly keepOpen?: boolean;
    readonly message?: string;
  } = {},
) {
  const cancel = vi.fn();
  const getEventStream = vi.fn(async () =>
    readableEvents(events, options.keepOpen ?? false, cancel),
  );
  const send = vi.fn(async () => ({
    id: "session-1",
    continuationToken: "chat-1",
    cancel: vi.fn(),
    getEventStream,
  }));
  const route = (options.channel ?? channel).routes[0];
  if (!route || !("method" in route)) {
    throw new Error("Missing HTTP route.");
  }

  const request = new Request("http://localhost/eve/web", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "chat-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: options.message ?? "Hello" }],
        },
      ],
    }),
  });
  const response = await route.handler(request, { send } as unknown as RouteHandlerArgs);
  if (!(response instanceof Response)) {
    throw new Error("Expected an HTTP response.");
  }

  const result = await readChunks(response);
  return {
    cancel,
    ...result,
    contentType: response.headers.get("content-type"),
    getEventStream,
    protocol: response.headers.get("x-vercel-ai-ui-message-stream"),
    send,
    status: response.status,
  };
}

async function readChunks(response: Response) {
  const chunks: Record<string, unknown>[] = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {") || line === "data: [DONE]") {
      continue;
    }

    const chunk: unknown = JSON.parse(line.slice(6));
    if (!isRecord(chunk) || typeof chunk.type !== "string") {
      throw new Error("Invalid UI message chunk.");
    }
    chunks.push(chunk);
  }
  return { chunks };
}

function readableEvents(
  events: readonly EveEvent[],
  keepOpen: boolean,
  cancel: () => void,
): ReadableStream<EveEvent> {
  return new ReadableStream({
    cancel,
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      if (!keepOpen) {
        controller.close();
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
