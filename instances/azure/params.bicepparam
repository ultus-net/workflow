// DRAFT instance parameters (W147 seed, 2026-09-26).
// Fill every TODO in the work instance repo. Values only — secrets ride
// Key Vault references configured in the pipeline, never this file.
// `using` points at a module materialized from the pinned open-core checkout.

using 'TODO_openCore_modules.bicep'

param location = 'TODO_region'
param appName = 'TODO_app_name'
param registry = 'TODO_registry'
param imageDigest = 'TODO_IMAGE_DIGEST' // must match the pipeline's pin
