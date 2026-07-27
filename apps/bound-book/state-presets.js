// state-presets.js — maps a US state to the extra transaction fields it
// requires, so selecting a state auto-configures the record.
//
// IMPORTANT: these presets are STARTER TEMPLATES, not legal advice, and are not
// exhaustive. Firearm recordkeeping requirements vary and change; a licensee
// must confirm their state's current rules. Only well-established examples are
// seeded here; every other state defaults to the federal baseline (no extra
// fields) until accurate data is added. Presets remain fully editable in-app.
//
// Runs in the browser (window.StatePresets) and Node (require) for tests.

(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.StatePresets = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATES = [
    { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
    { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
    { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
    { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
    { code: 'DC', name: 'District of Columbia' }, { code: 'FL', name: 'Florida' },
    { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
    { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' },
    { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
    { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
    { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' },
    { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
    { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
    { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' },
    { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
    { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
    { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' },
    { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
    { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
    { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' },
    { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
    { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
    { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' },
    { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
    { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
    { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' },
    { code: 'WY', name: 'Wyoming' }
  ];

  // state code -> extra fields. Seeded conservatively from public state
  // requirements; expand per verified rules. Still confirm against your state's
  // current law and your ATF/state guidance — this is not legal advice.
  var PRESETS = {
    CA: [
      { label: 'DROS number', side: 'disposition', required: true }
    ],
    // Florida is a full point-of-contact state: all dealer sales (handgun and
    // long gun) run through FDLE, which issues an approval number the dealer
    // records and attaches to the 4473. Delivery is held for the 3-day waiting
    // period (excl. weekends/holidays) or until the check clears — whichever is
    // later — with exemptions (e.g. CWFL holders, trade-ins).
    FL: [
      { label: 'FDLE approval number', side: 'disposition', required: true },
      { label: 'Delivery date (waiting period cleared)', side: 'disposition', required: false },
      { label: 'Waiting-period exemption', side: 'disposition', required: false }
    ]
  };

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  // Deterministic id so re-selecting the same state doesn't churn field ids
  // (recorded values stay mapped). Payload key becomes 'custom_' + id.
  function fieldId(code, label) {
    return 'st_' + String(code).toLowerCase() + '_' + slug(label);
  }

  // Reconcile the custom-field list to a chosen state: drop previously
  // state-sourced fields, keep manual ones, add the new state's preset fields.
  // Pure — returns a new array.
  function applyState(currentFields, code) {
    var kept = (currentFields || []).filter(function (f) { return f.source !== 'state'; });
    var preset = PRESETS[code] || [];
    var added = preset.map(function (p) {
      return { id: fieldId(code, p.label), label: p.label, side: p.side, required: !!p.required, source: 'state' };
    });
    return kept.concat(added);
  }

  return {
    STATES: STATES,
    PRESETS: PRESETS,
    slug: slug,
    fieldId: fieldId,
    applyState: applyState
  };
});
