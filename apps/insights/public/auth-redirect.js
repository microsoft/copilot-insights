globalThis.msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
  document.getElementById('auth-result').textContent = 'Sign-in could not finish. Return to the Insights portal and try again.';
});
