(() => {
  const normalise = (value) => value.trim().toLocaleLowerCase('en-GB');

  const appSearchForm = document.querySelector('#search');
  const appSearch = document.querySelector('#app-search');
  const appRows = [...document.querySelectorAll('#app-list [data-app-name]')];
  const appStatus = document.querySelector('#search-status');
  const appNoResults = document.querySelector('#no-results');

  if (appSearchForm && appSearch && appRows.length && appStatus && appNoResults) {
    const filterApps = () => {
      const query = normalise(appSearch.value);
      let matches = 0;

      appRows.forEach((row) => {
        const match = !query || normalise(row.dataset.appName).includes(query);
        row.hidden = !match;
        if (match) matches += 1;
      });

      appNoResults.hidden = matches !== 0;
      if (!query) {
        appStatus.textContent = 'Showing 3 example reports.';
      } else if (matches === 0) {
        appStatus.textContent = `No example reports found for “${appSearch.value.trim()}”.`;
      } else {
        appStatus.textContent = `${matches} example report${matches === 1 ? '' : 's'} found.`;
      }
    };

    appSearchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      filterApps();
    });
    appSearch.addEventListener('input', filterApps);
    filterApps();
  }

  const trackerSearch = document.querySelector('#tracker-search');
  const purposeFilter = document.querySelector('#purpose-filter');
  const trackerRows = [...document.querySelectorAll('#tracker-list .tracker-row')];
  const trackerCount = document.querySelector('#tracker-count');
  const trackerNoResults = document.querySelector('#tracker-no-results');

  if (trackerSearch && purposeFilter && trackerRows.length && trackerCount && trackerNoResults) {
    const filterTrackers = () => {
      const query = normalise(trackerSearch.value);
      const purpose = purposeFilter.value;
      let matches = 0;

      trackerRows.forEach((row) => {
        const searchable = normalise(`${row.dataset.name} ${row.dataset.company} ${row.dataset.country} ${row.dataset.purpose}`);
        const match = (!query || searchable.includes(query)) && (purpose === 'all' || row.dataset.purpose === purpose);
        row.hidden = !match;
        if (match) matches += 1;
      });

      trackerNoResults.hidden = matches !== 0;
      if (!query && purpose === 'all') {
        trackerCount.textContent = '6 of 30 trackers shown in this preview';
      } else {
        trackerCount.textContent = `${matches} of 6 representative trackers shown · 30 detected overall`;
      }
    };

    trackerSearch.addEventListener('input', filterTrackers);
    purposeFilter.addEventListener('change', filterTrackers);
    filterTrackers();
  }
})();
