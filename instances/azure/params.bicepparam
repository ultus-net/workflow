// DRAFT instance parameters (W147 seed, 2026-09-26).
// Fill every TODO in the work instance repo. Values only — secrets ride
// Key Vault references configured in the pipeline, never this file.
// `using` points at the instance-owned module: the C0-lineage bicep lives in
// this repo post-extraction; the openCore checkout pins the verified open ref
// for provenance (and, later, generic modules contributed back open-side);
// the pin expectation is downloaded from the release, not read from that tree.

using 'TODO_plane_modules.bicep'

param location = 'TODO_region'
param appName = 'TODO_app_name'
param registry = 'TODO_registry'
param imageDigest = 'TODO_IMAGE_DIGEST' // must match the pipeline's pin
