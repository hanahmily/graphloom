import { type GraphAction, type GraphDecision, type GraphDefinition, type RunView, type WireRequest, type WireResponse } from "./types.js";
export declare class WireValidationError extends Error {
    readonly code: "malformed" | "stale" | "oversized" | "unknown";
    constructor(code: WireValidationError["code"], message: string);
}
export declare function parseJsonBounded(raw: string, maxBytes?: number): unknown;
export declare function assertWireRequest(value: unknown): WireRequest;
export declare function assertWireResponse(value: unknown): WireResponse;
export declare function assertGraphDefinition(value: unknown): GraphDefinition;
export declare function assertGraphDecision(value: unknown): GraphDecision;
export declare function assertGraphAction(value: unknown): GraphAction;
export declare function assertRunView(value: unknown): RunView;
//# sourceMappingURL=validate.d.ts.map