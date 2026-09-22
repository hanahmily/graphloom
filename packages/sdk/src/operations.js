export function dispatch(job, reason, privateState) {
    return decide({ type: "dispatch", job }, reason, privateState);
}
export function observe(observeSpec, reason, privateState) {
    return decide({ type: "observe", observe: observeSpec }, reason, privateState);
}
export function validate(validateSpec, reason, privateState) {
    return decide({ type: "validate", validate: validateSpec }, reason, privateState);
}
export function reenter(reenterSpec, reason, privateState) {
    return decide({ type: "reenter", reenter: reenterSpec }, reason, privateState);
}
export function supervise(superviseSpec, reason, privateState) {
    return decide({ type: "supervise", supervise: superviseSpec }, reason, privateState);
}
export function qualifyRepair(qualify, reason, privateState) {
    return decide({ type: "qualify_repair", qualify }, reason, privateState);
}
export function activateRepair(activate, reason, privateState) {
    return decide({ type: "activate_repair", activate }, reason, privateState);
}
export function returnToNormal(returnSpec, reason, privateState) {
    return decide({ type: "return", return: returnSpec }, reason, privateState);
}
export function stop(stopSpec, reason, privateState) {
    return decide({ type: "stop", stop: stopSpec }, reason, privateState);
}
function decide(action, reason, privateState) {
    const decision = { action, reason };
    if (privateState !== undefined) {
        decision.privateState = privateState;
    }
    return decision;
}
//# sourceMappingURL=operations.js.map