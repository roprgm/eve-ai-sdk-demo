import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, generateId, type UIMessage } from "ai";
import { type KeyboardEvent, type SubmitEvent, use } from "react";
import { createRoot } from "react-dom/client";

const chatApi = "/eve/web";

function getChatId() {
  return new URL(location.href).searchParams.get("chat");
}

function setChatId(chatId: string) {
  const url = new URL(location.href);
  url.searchParams.set("chat", chatId);
  history.replaceState(history.state, document.title, url);
}

async function getInitialState(): Promise<{ id: string; messages: UIMessage[] }> {
  const chatId = getChatId();

  if (!chatId) {
    return {
      id: generateId(),
      messages: [],
    };
  }

  const response = await fetch(`${chatApi}/${chatId}`);
  return {
    id: chatId,
    messages: await response.json(),
  };
}

const initialStatePromise = getInitialState();

function App() {
  const initialState = use(initialStatePromise);

  const { id, messages, sendMessage, status } = useChat({
    id: initialState.id,
    messages: initialState.messages,
    resume: true,
    transport: new DefaultChatTransport({ api: chatApi }),
  });

  const isLoading =
    status === "submitted" || (status === "streaming" && !messages.at(-1)?.parts.length);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("message");
    if (typeof value !== "string" || status !== "ready") {
      return;
    }

    const text = value.trim();
    if (!text) {
      return;
    }

    event.currentTarget.reset();
    setChatId(id);
    void sendMessage({ text });
  }

  return (
    <main className="chat">
      <output className="messages">
        {messages.map((message) => (
          <p className="message" data-role={message.role} key={message.id}>
            {message.parts.map((part, index) => {
              const key = `${message.id}:${index}`;
              if (part.type === "text") {
                return <span key={key}>{part.text}</span>;
              }
              return null;
            })}
          </p>
        ))}
        {isLoading && <p className="message loading">...</p>}
        <span className="scroll-anchor" />
      </output>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          aria-label="Message"
          name="message"
          onKeyDown={onKeyDown}
          placeholder="Message Eve"
          required
          rows={1}
        />
        <button aria-label="Send message" disabled={status !== "ready"} type="submit">
          ↑
        </button>
      </form>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element.");
}

createRoot(root).render(<App />);
