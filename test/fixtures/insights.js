'use strict';
const { INSIGHT_LISTS, INSIGHT_OBJECTS } = require('../../lib/narrative');

/*
 * The insights section is only accepted when every section the report renders is present (a reply with sections missing
 * is incomplete, not a smaller answer). Tests that care about one field start from this empty-but-complete skeleton.
 */
const complete = (overrides = {}) => ({
  ...Object.fromEntries(INSIGHT_LISTS.map((key) => [key, []])),
  ...Object.fromEntries(INSIGHT_OBJECTS.map((key) => [key, {}])),
  ...overrides
});

module.exports = { complete };
