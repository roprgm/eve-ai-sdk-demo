# Eve + Vercel AI SDK

Use the Vercel AI SDK's standard [`useChat()`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
hook with a durable [Eve](https://eve.dev) agent.

An Eve channel adapter that translates durable session events into the AI SDK UI Message Stream
protocol, with history, stream reconnection, and a minimal React client.

## Usage

### React client

Use `useChat()` as you normally would in an AI SDK UI application. Point its standard
`DefaultChatTransport` at the Eve channel; the rest of the hook API stays the same:

```tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/eve/web" }),
  });

  return (
    <main>
      {messages.map((message) => (
        <p key={message.id}>
          <strong>{message.role}: </strong>
          {message.parts.map((part, index) => {
            if (part.type !== "text") {
              return null;
            }

            return <span key={index}>{part.text}</span>;
          })}
        </p>
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setInput("");
          void sendMessage({ text: input });
        }}
      >
        <input value={input} onChange={(event) => setInput(event.target.value)} />
        <button disabled={status !== "ready"}>Send</button>
      </form>
    </main>
  );
}
```

That is enough for a new conversation. Messages stream through the regular AI SDK UI Message
Stream protocol while Eve runs and persists the agent session. This minimal example renders text
parts; add cases for tool and data parts as your UI needs them.

`useChat()` normally posts to `/api/chat`. Setting `api` points the same standard AI SDK transport
at `/eve/web`. There is no custom client protocol or application API route between `useChat()` and
Eve.

### Add the channel to your Eve project

Install the dependencies with Bun or your preferred package manager:

```bash
bun add eve ai @ai-sdk/react
```

Then copy [`lib/ai-sdk-channel.ts`](lib/ai-sdk-channel.ts) into your project and define the
application channel:

```ts
import { none } from "eve/channels/auth";

import { aiSdkChannel } from "../../lib/ai-sdk-channel";

export default aiSdkChannel({
  auth: [none()],
  onMessage(ctx, message) {
    console.log(ctx, message);
    return { auth: null };
  },
});
```

Save that file as `agent/channels/ai-sdk.ts` so Eve discovers it automatically. The reusable
`aiSdkChannel()` implementation validates AI SDK messages, starts or continues the Eve
session, translates Eve events into AI SDK UI Message Stream chunks, restores history, and
reconnects active streams.

Like Eve's built-in channels, the constructor also accepts `cors`, `events`, and an `onMessage`
hook that can set session auth, add context, or skip dispatch. The demo passes `none()` so it works
without setup. Replace it with your application's authentication before deploying it to production.

The channel exposes three routes:

| Request | Purpose |
| --- | --- |
| `POST /eve/web` | Start or continue a conversation and stream its response. |
| `GET /eve/web/:id` | Restore the conversation's messages. |
| `GET /eve/web/:id/stream` | Reconnect to a response that is still running. |

## Restore conversations from a chat ID

The AI SDK assigns each chat an ID. This channel uses that ID as Eve's durable continuation token,
so persisting it is enough to recover the conversation.

`useChat()` does not prescribe how applications store or load conversations. Its transport sends
messages and reconnects active streams; existing history is passed in through `messages`. Keep the
API path in one place and use it for both operations:

```tsx
const chatApi = "/eve/web";
const chatId = "your-chat-id";
const initialMessages = await fetch(`${chatApi}/${chatId}`).then((response) => response.json());

function Chat() {
  const chat = useChat({
    id: chatId,
    messages: initialMessages,
    resume: true,
    transport: new DefaultChatTransport({ api: chatApi }),
  });
}
```

This demo stores the chat ID in the URL, but that storage choice is separate from the channel
contract.

## What you get

- Incremental text streaming without resending cumulative content.
- Durable conversations backed by Eve's event journal.
- Refresh-safe history and active-stream reconnection.
- Tool calls and results represented as standard AI SDK chunks.
- A frontend that only depends on the familiar AI SDK React API.

The reusable adapter lives in [`lib/ai-sdk-channel.ts`](lib/ai-sdk-channel.ts). The application-owned
[`agent/channels/ai-sdk.ts`](agent/channels/ai-sdk.ts) only configures authentication and exports the
channel Eve discovers.

## Run the demo

Requirements: Node.js 24, Bun 1.3.14 or newer, and a Vercel AI Gateway API key.

```bash
bun install
cp .env.example .env.local
```

Add `AI_GATEWAY_API_KEY` to `.env.local`, then run:

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy

Import the repository into Vercel and select **Services** as the Framework Preset. The included
[`vercel.json`](vercel.json) builds the Vite frontend and Eve agent together.

Eve uses Vercel AI Gateway through project OIDC when deployed, so the local API key is not required
on Vercel.

## Verify

```bash
bun run check
bun run typecheck
bun run test
bun run build
bun run build:agent
```

## Learn more

- [Eve documentation](https://eve.dev/docs)
- [Vercel AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui/overview)
- [`useChat()` reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
