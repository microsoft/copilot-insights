# Azure validation

Initial run: **October 3, 2026 UTC (October 2, 2026 PDT)**. Cleanup verified: **October 3, 2026 UTC/PDT**. This record intentionally omits subscription/tenant IDs, resource names, private endpoint addresses, account identifiers, certificate fingerprints, keys, and private deployment links.

## Result

**The previous Azure validation deployment has been removed. End-to-end authenticated cloud telemetry validation was not completed and is not a passing result.** Before cleanup, the supplied ownership reference was accepted and the ingestion API was registered in the intended tenant with assignment-required token issuance. The collector was activated with the real application audience and was healthy. The validation runner blocked subsequent diagnostic commands before execution, including a credential-free TLS probe. This was not an observed Azure authentication rejection and must not be reported as an ingestion test result. This template did not deploy a cloud analytics portal.

The [native local-client verification](local-validation.md#native-client-emission-and-restoration) and later [organization walkthrough](local-validation.md#organization-walkthrough) remain separate local evidence. Their VS Code settings were restored byte for byte. Neither exercise replayed local captures to Azure or uploaded real-work telemetry.

## Verified

This table records the historical deployment checks, not currently running resources. See [cleanup](#retention-and-cleanup) for the verified current state.

| Check | Observed result |
|---|---|
| New resource group in the requested subscription | Created in West US 2, tagged for isolated synthetic-only validation |
| ARM deployment | Infrastructure deployment and collector-only activation both `Succeeded`; activation reused the already-uploaded certificate without reopening its private key |
| Collector activation | One running collector with a healthy revision, non-root process, authenticated profile, and the actual target-tenant audience |
| Ingestion registration | Single-tenant API with v2 access tokens, administrator diagnostic scope, Azure CLI diagnostic preauthorization, assignment required, and one assigned operator |
| Diagnostic token issuance | Correct tenant/audience, v2 token, `Telemetry.Write` scope, and the assigned writer role verified locally; this is not proof of token acceptance by the collector |
| Image publication | Pinned upstream base and source configuration layer published from within the private environment; recorded manifest/configuration confirms the expected layer digest, entrypoint, authenticated command, and non-root user |
| Container Apps environment | Internal VNet configuration enabled |
| Container Registry | Public access disabled, administrator credentials disabled |
| Application Insights and usage workspace | Public ingestion disabled and local authentication disabled |
| Private endpoints | Both registry and Azure Monitor connections approved |
| Custom-hostname certificate | Uploaded fingerprint matches the local certificate; the collector's ARM configuration binds that certificate using SNI and disables insecure ingress |
| Usage workspace query | Target-tenant authenticated query succeeded and returned zero usage rows at the baseline; no authorized test telemetry had been sent |
| Local certificate trust | Public certificate trusted in `CurrentUser\Root`, not machine-wide trust |
| Actual local HTTPS request | Normal Windows certificate validation accepted a loopback HTTPS listener using the generated certificate; an address absent from its SANs was rejected with a hostname mismatch |
| Certificate rollback | Disposable lifecycle test exercised trust, untrust, and removal without leaving its test certificate; the requested development certificate remains trusted for the lab |
| Azure-hosted one-click entry | A versioned, RBAC-protected Template Spec contains the same JSON values as the local artifact and passed Azure provider validation |
| Browser entry | The Template Spec deployment link reached Azure sign-in; an authenticated interactive deployment form was not exercised |
| Public GitHub badge | Correct encoded ARM-template URL is in the README, but the raw URL returned 404 before publication; it is not a verified live public deployment button |
| Regression checks | Setup/restore, telemetry-reader, fixture-contract, analytics, certificate, and ARM-contract suites passed; new offline remote-verification tests cover tenant selection, HTTPS, redirects, and no anonymous fallback |

The successful HTTPS probe was a **temporary loopback diagnostic listener**, not the local collector's HTTP port and not an Azure ingress request. The Azure certificate binding was checked through the control plane; an actual cloud TLS handshake was not completed. No test bypassed certificate or hostname validation. The default lab certificate expires after seven days; rotate or remove it rather than disabling TLS checks.

An attempted dedicated ACR build pool failed to provision and was deleted. Publication instead used a temporary, registry-scoped managed-identity OCI publisher inside the private environment. The intended source layer and runtime settings were checked, but the resulting image is not claimed to be byte-identical to the local Docker build. Registry public access and administrator credentials remained disabled.

### Directory-routing correction

The tested Azure CLI's raw Graph requests used its default directory despite a supplied subscription argument. An unintended, newly created test registration and its service principal were removed and their absence verified. Registration was then repeated using an explicitly target-tenant Graph credential; existing unrelated applications were not modified. The operator's CLI default account was preserved. The [registration instructions](infrastructure.md#register-the-ingestion-api) now use explicit tenant-scoped Graph authentication, and remote verification requires `-TenantId` rather than relying on the CLI default.

## Not verified

- Native VS Code or synthetic OTLP delivery to the Azure collector.
- Correct-token acceptance, missing/wrong-token rejection, or production sender enrollment.
- Actual cloud HTTPS trust/hostname verification from a diagnostic client.
- Managed-identity telemetry export, durable traces/metrics/logs in the usage workspace, or stored-data privacy canaries.
- A client network route/DNS connection to this new private environment.
- An Azure-backed analytics adapter, authenticated shared portal, or durable shared human-review workflow. The existing portal remains a local file/demo evaluation service.
- Intune-managed client packaging, lifecycle, trust distribution, or production authentication.

An empty workspace is not proof of filtering, a healthy collector is not proof of ingestion, and a locally trusted certificate is not proof of Azure endpoint TLS. The placeholder audience used in the earlier infrastructure-only phase was replaced with the verified target-tenant registration before collector activation. No native or fixture telemetry was replayed to cloud storage to manufacture an analytics result.

## Resume safely

1. A future cloud test requires a fresh isolated deployment and approved ingestion identity: the previous resource group, Template Spec, and active registration are deleted. Follow the [deployment guide](infrastructure.md#deploy), reconfirm operator assignment and certificate validity, and keep real deployment values private. Do not assume a recorded endpoint or private deployment link still exists.
2. Obtain a permitted private diagnostic execution path. Do not work around execution restrictions, expose ingestion publicly, export user credentials into another workload, or disable bearer-token/TLS checks to make a test pass.
3. Verify actual HTTPS/SNI and trust, run the synthetic [remote verification](infrastructure.md#verify) with explicit `-TenantId`, and prove missing/invalid/wrong-resource token rejection. Verify all three span operations, the retained metric families and feedback log, and zero stored canaries after ingestion delay.
4. Compose insights from those actual stored cloud records and implement the missing Azure-backed portal/shared-review boundary. Do not relabel the local file or demo portal as an Azure data source. A separate native-client cloud exercise must use a disposable workspace and restore settings afterward.
5. Complete the [Intune production gates](intune-deployment.md) before any organization rollout. Administrator validation scripts are not employee enrollment instructions.

## Retention and cleanup

At the user's request, cleanup was completed and verified on **October 3, 2026**:

| Cleanup target | Verification |
|---|---|
| Recorded validation resource group | Azure reports that the group no longer exists, including its collector, registry/images, monitoring resources, network, uploaded certificate, and Template Spec |
| Container Apps managed infrastructure group | Azure reports that the associated managed group no longer exists |
| Recorded ingestion application and enterprise service principal | Explicit target-tenant Microsoft Graph lookups return HTTP 404 for both active objects |
| Local VS Code settings | Exact original bytes restored; temporary settings snapshot removed |

Only the recorded isolated deployment and its owned directory objects were removed. Directory deletion is not a claim of permanent purge of recoverable deleted objects. The deleted Template Spec's private deployment link is no longer usable; the public template source and deployment instructions remain in the repository. Review/expiry tags did not perform this cleanup automatically.

Deployment metadata and validation evidence live outside the repository under the current user's `%LOCALAPPDATA%\CopilotInsights\AzureValidation` directory. Certificate/private-key material is in the helper's restricted certificate directory. Temporary plaintext secure-parameter files were removed after deployment/validation. Do not publish these private directories or raw cloud exports.

The separately requested local development certificate and its current-user trust were retained; removing cloud resources does not require removing that local lab setup. To reverse it separately, use [the certificate helper's `Untrust` and `Remove` commands](infrastructure.md#development-https-certificate). Do not delete unrelated registrations, client networks, or certificates.
