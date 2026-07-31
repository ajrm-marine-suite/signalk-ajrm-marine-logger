"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const createPlugin = require("../plugin");

test("Logger is an inert retirement marker that points to Capture", () => {
  const statuses = [];
  const errors = [];
  const plugin = createPlugin({
    setPluginStatus(value) {
      statuses.push(value);
    },
    setPluginError(value) {
      errors.push(value);
    },
  });
  plugin.start({});
  assert.match(plugin.name, /retired/i);
  assert.match(plugin.description, /Capture/);
  assert.match(statuses[0], /Capture v0\.7\.0/);
  assert.match(errors[0], /retired/i);
});
