
import dashboardLoginHandler from "../../api/dashboard-login.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

export async function handleDashboardLogin(
  request,
  env
) {
  return runLegacyHandler(
    request,
    dashboardLoginHandler
  );
}
