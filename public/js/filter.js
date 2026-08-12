// Client-side filter for the tracker and company directories. The tables are
// rendered in full, so filtering is a local narrowing of what is already on the
// page and needs no requests.
(function () {
  'use strict';

  var input = document.getElementById('directory-filter');
  if (!input) return;

  var table = document.querySelector(input.getAttribute('data-filter-target'));
  if (!table) return;

  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  var empty = document.getElementById('directory-empty');

  function apply() {
    var term = input.value.trim().toLowerCase();
    var visible = 0;

    rows.forEach(function (row) {
      var haystack = row.getAttribute('data-filter') || '';
      var matches = term === '' || haystack.indexOf(term) !== -1;
      row.style.display = matches ? '' : 'none';
      if (matches) visible++;
    });

    if (empty) empty.classList.toggle('d-none', visible > 0);
  }

  input.addEventListener('input', apply);
  apply();
})();
