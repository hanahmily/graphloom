import { describe, expect, it } from "vitest";
import { resolveMiniMaxCredential } from "./credentials.js";

describe("resolveMiniMaxCredential", () => {
  it("prefers an explicit apiKey", () => {
    const resolved = resolveMiniMaxCredential({
      apiKey: " sk-explicit ",
      env: {
        MINIMAX_CN_API_KEY: "sk-cn",
        MINIMAX_API_KEY: "sk-general",
      },
    });
    expect(resolved).toEqual({ apiKey: "sk-explicit", source: "options" });
  });

  it("uses MINIMAX_CN_API_KEY before MINIMAX_API_KEY", () => {
    const resolved = resolveMiniMaxCredential({
      env: {
        MINIMAX_CN_API_KEY: "sk-cn",
        MINIMAX_API_KEY: "sk-general",
      },
    });
    expect(resolved).toEqual({ apiKey: "sk-cn", source: "env:MINIMAX_CN_API_KEY" });
  });

  it("falls back to MINIMAX_API_KEY", () => {
    const resolved = resolveMiniMaxCredential({
      env: { MINIMAX_API_KEY: "sk-general" },
    });
    expect(resolved).toEqual({ apiKey: "sk-general", source: "env:MINIMAX_API_KEY" });
  });

  it("defers to Pi-stored credentials when env is empty", () => {
    const resolved = resolveMiniMaxCredential({ env: {} });
    expect(resolved).toEqual({ source: "pi-stored" });
  });
});
