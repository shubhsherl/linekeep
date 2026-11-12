import { analyticsClient } from "./analytics";
import { callLogsClient } from "./call-logs";
import { coreClient } from "./core";
import { customersClient } from "./customers";
import { logicJavaScript } from "./logic";
import { whatsappClient } from "./whatsapp";

/**
 * One script, one scope: pure logic, runtime, then the views. Every piece is a plain-JavaScript string so the
 * Worker needs no bundler and the pure logic can be tested from the very same source.
 */
export const webClientJavaScript = `(() => {
'use strict';
${logicJavaScript}
${coreClient}
${customersClient}
${whatsappClient}
${analyticsClient}
${callLogsClient}
boot();
})();
`;
