"use strict";

const packageInfo = require("../package.json");

module.exports = function retiredAjrmMarineLogger(app) {
  return {
    id: "signalk-ajrm-marine-logger",
    name: "AJRM Marine Logger (retired)",
    description:
      "Retired in v0.7.0. Recording and replay are now provided by AJRM Marine Capture.",
    schema: {
      type: "object",
      properties: {},
    },
    start() {
      const message =
        `AJRM Marine Logger v${packageInfo.version} is retired; install AJRM Marine Capture v0.7.0 or later`;
      app.setPluginError?.(message);
      app.setPluginStatus?.(message);
    },
    stop() {},
  };
};
