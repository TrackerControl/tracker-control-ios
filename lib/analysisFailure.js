function classifyAnalysisFailure(logs) {
  const text = logs || '';

  if (/app not found/i.test(text)) {
    return {
      reason: 'app_not_found',
      retryable: false
    };
  }

  if (/Download exceeded MAX_ATTEMPT_DOWNLOAD_BYTES|above MAX_APP_SIZE_BYTES/i.test(text)) {
    return {
      reason: 'ipa_too_large',
      retryable: false
    };
  }

  if (/DeviceOSVersionTooLow|system version is lower than the minimum OS version/i.test(text)) {
    return {
      reason: 'ios_version_too_low',
      retryable: false
    };
  }

  if (/purchasing paid apps is not supported/i.test(text)) {
    return {
      reason: 'paid_app',
      retryable: false
    };
  }

  return {
    reason: 'analysis_failed',
    retryable: true
  };
}

module.exports = { classifyAnalysisFailure };
