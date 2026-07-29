import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-4.7-flash",
  reasoning: "none",
  limits: {
    maxInputTokensPerSession: 20_000,
    maxOutputTokensPerSession: 2_000,
  },
});
