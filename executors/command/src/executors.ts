/** Entry module the host loads in an executor process. */
import { createCommandExecutor } from "./run.js";

export const executors = [createCommandExecutor()];
