(function () {
  'use strict';

  var input = document.getElementById('tracker-filter');
  if (!input) return;

  var rows = Array.prototype.slice.call(document.querySelectorAll('.tracker-list .tracker-row'));
  var count = document.getElementById('tracker-result-count');
  var empty = document.getElementById('tracker-no-results');

  function plural(value, singular, pluralForm) {
    return value + ' ' + (value === 1 ? singular : pluralForm);
  }

  function apply() {
    var term = input.value.trim().toLowerCase();
    var visible = 0;
    var visibleThirdParty = 0;
    var visibleSystem = 0;
    var totalThirdParty = 0;

    rows.forEach(function (row) {
      var isSystem = row.getAttribute('data-system') === 'true';
      if (!isSystem) totalThirdParty += 1;
      var haystack = (row.getAttribute('data-filter') || '').toLowerCase();
      var matches = term === '' || haystack.indexOf(term) !== -1;
      row.hidden = !matches;
      if (matches) {
        visible += 1;
        if (!isSystem) visibleThirdParty += 1;
        if (isSystem) visibleSystem += 1;
      }
    });

    if (empty) empty.hidden = visible > 0;
    if (!count) return;

    if (term === '') {
      count.textContent = plural(totalThirdParty, 'third-party tracker shown', 'third-party trackers shown');
    } else {
      count.textContent = plural(visibleThirdParty, 'third-party tracker matches', 'third-party tracker matches')
        + ' of ' + totalThirdParty
        + (visibleSystem > 0 ? '; ' + plural(visibleSystem, 'System API signature matches', 'System API signatures match') : '');
    }
  }

  input.addEventListener('input', apply);
  apply();
}());
