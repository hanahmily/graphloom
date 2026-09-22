/**
 * In-process GraphPlugin that returns canned decisions for host-loop tests.
 * Throws when advance is called more times than scripted.
 */
export function createScriptedGraph(options) {
    let index = 0;
    const { definition, advances } = options;
    return {
        describe() {
            return structuredClone(definition);
        },
        advance(view) {
            if (index >= advances.length) {
                throw new Error(`scripted graph exhausted: advance called ${index + 1} times, only ${advances.length} scripted`);
            }
            const step = advances[index];
            if (step === undefined) {
                throw new Error(`scripted graph missing step at index ${index}`);
            }
            const current = index;
            index += 1;
            if (typeof step === "function") {
                return step(view, current);
            }
            return structuredClone(step);
        },
    };
}
//# sourceMappingURL=scripted.js.map