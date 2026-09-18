import { startWorkflowWeb } from "./web-service.js";

const service = await startWorkflowWeb();
console.log(`Workflow browser UI: ${service.url}`);

async function shutdown(): Promise<void> {
  await service.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
