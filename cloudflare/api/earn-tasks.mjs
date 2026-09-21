
import earnTasksHandler from "../../api/earn-tasks.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

export async function handleEarnTasks(
  request,
  env
) {
  return runLegacyHandler(
    request,
    earnTasksHandler
  );
}
