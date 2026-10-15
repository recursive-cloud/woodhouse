# multi-app-operation Specification

## Purpose

Multi-App operation: one container serving several private GitHub Apps, each with its own credentials and webhook secret, routed by GitHub's own delivery headers before signature verification.

## Requirements

### Requirement: Each App is served by its own Probot instance
Each configured App SHALL be served by its own Probot instance with its own webhook secret, created at startup from the operator-supplied App-definition file — a CommonJS function of the environment. Per-App settings — installation allowlist, baseline repository and label — SHALL be honoured, with the allowlist and baseline repository inherited from the global defaults when unset, and every App SHALL end up with an allowlist and a baseline repository either way.

#### Scenario: Two Apps, one container
- **WHEN** the App-definition file configures two Apps
- **THEN** both are registered at startup and the startup log lists both labels

#### Scenario: Per-App allowlist overrides the default
- **WHEN** an App definition sets its own `allowedInstallationTargets`
- **THEN** that App's boundary is its own list, independent of the global default

### Requirement: Deliveries route by GitHub's App target header
An incoming delivery SHALL be routed to the App named by the `X-GitHub-Hook-Installation-Target-ID` header before its signature is verified — necessarily, since each App has its own secret. Deliveries for an App this instance does not serve SHALL be rejected with 404; deliveries that did not come from a GitHub App SHALL be rejected with 400.

#### Scenario: Unknown App
- **WHEN** a delivery names an App ID this instance is not configured to serve
- **THEN** the delivery is rejected with 404 and a warning is logged

#### Scenario: Repository-level webhook
- **WHEN** a delivery's target type is not a GitHub App
- **THEN** the delivery is rejected with 400 as an unsupported target type

### Requirement: Routing precedes verification, and verification still binds
The signature SHALL be verified with the selected App's own secret; a forged target header only selects a key the sender cannot produce a valid signature for. An invalid signature SHALL be rejected with 400; a handler that throws SHALL produce a 500 so the delivery is marked failed and can be redelivered.

#### Scenario: Forged header, no matching signature
- **WHEN** a delivery carries a target header naming a served App but an invalid signature
- **THEN** the delivery is rejected with 400 as an invalid signature

#### Scenario: Handler failure is surfaced
- **WHEN** a handler throws while processing a verified delivery
- **THEN** the delivery response is 500 so GitHub marks it failed and it can be redelivered

### Requirement: App-configuration mistakes are fatal at boot
A missing App-definition file, a file that does not export a function, a definition that fails schema validation, an unset environment variable producing an unusable App ID, or a private key that is not a PEM SHALL each terminate startup with a targeted configuration error naming the file or App at fault.

#### Scenario: Unset environment variable
- **WHEN** the App-definition file reads an unset variable and produces an unusable App entry
- **THEN** startup fails with a message pointing at the App and the unset variable

#### Scenario: Key is not a PEM
- **WHEN** an App's private key is neither a PEM nor a base64 encoding of one
- **THEN** startup fails naming the App

### Requirement: Health reports the served Apps
The health endpoint SHALL report success and the number of Apps served.

#### Scenario: Health check
- **WHEN** `/healthz` is requested while two Apps are served
- **THEN** it responds 200 with the App count
