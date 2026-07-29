import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5-nano",
  limits: {
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 2_000,
  },
});
