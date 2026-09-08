(function () {
  'use strict';

  var input = document.getElementById('directory-filter');
  if (!input) return;

  var target = input.getAttribute('data-filter-target');
  var table = target ? document.querySelector(target) : null;
  if (!table) return;

  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  var empty = document.getElementById('directory-empty');
  var count = document.getElementById('directory-count');

  function apply() {
    var term = input.value.trim().toLowerCase();
    var visible = 0;

    rows.forEach(function (row) {
      var haystack = row.getAttribute('data-filter') || '';
      var matches = term === '' || haystack.indexOf(term) !== -1;
      row.hidden = !matches;
      if (matches) visible += 1;
    });

    if (empty) empty.hidden = visible > 0;
    if (count) count.textContent = visible + ' entr' + (visible === 1 ? 'y' : 'ies');
  }

  input.addEventListener('input', apply);
  apply();
}());
