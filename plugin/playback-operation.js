"use strict";

function createPlaybackOperation() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    current() {
      return generation;
    },
  };
}

module.exports = { createPlaybackOperation };
