import dashboardDataHandler from "../../api/dashboard-data.js";

import {
  runLegacyHandler
} from "./legacy-adapter.mjs";

export async function handleDashboardData(
  request,
  env
) {
  return runLegacyHandler(
    request,
    dashboardDataHandler
  );
}
