// Docker health check: every service that this container's role runs must answer.
const role = process.env.COPILOT_INSIGHTS_ROLE || 'all';
const urls: string[] = [];
if (role !== 'portal') urls.push(`http://127.0.0.1:${(process.env.CI_HEALTH_ENDPOINT || '0.0.0.0:13133').split(':').pop()}/`);
if (role !== 'collector') urls.push(`http://127.0.0.1:${process.env.PORT || 8080}/api/health`);
const healthy = await Promise.all(urls.map((url) => fetch(url, { signal: AbortSignal.timeout(2_500) }).then((response) => response.ok, () => false)));
process.exit(healthy.every(Boolean) ? 0 : 1);
