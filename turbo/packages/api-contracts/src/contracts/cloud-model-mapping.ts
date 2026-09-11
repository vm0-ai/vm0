import {
  isActiveRunModel,
  isSupportedRunModel,
  getFrameworkForType,
  getBuiltInConcreteProviderType,
  normalizeRunModelId,
  type ModelProviderType,
} from "./model-providers";

/** A policy explicitly binds its catalog model to one saved cloud deployment. */
export function isCloudModelMappingValid(
  type: ModelProviderType,
  catalogModel: string,
  configuredModel: string | null,
): boolean {
  if (type !== "azure-foundry" && type !== "aws-bedrock") return true;
  if (
    !isActiveRunModel(catalogModel) ||
    getFrameworkForType(getBuiltInConcreteProviderType(catalogModel)) !==
      "claude-code" ||
    !configuredModel
  )
    return false;
  if (type === "azure-foundry") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u.test(configuredModel))
      return false;
    const upstreamCatalogModel = normalizeRunModelId(configuredModel);
    return (
      !isSupportedRunModel(upstreamCatalogModel) ||
      upstreamCatalogModel === catalogModel
    );
  }
  // Opaque application/inference profiles require the explicit policy binding;
  // the native config separately verifies that the ARN matches the region.
  if (
    /^arn:aws:bedrock:[a-z0-9-]+:\d{12}:(?:application-inference-profile|inference-profile)\/[a-zA-Z0-9:._/-]+$/u.test(
      configuredModel,
    )
  )
    return true;
  const foundationModel =
    /^(?:(?:us|eu|apac|global)\.)?anthropic\.(claude-[a-z0-9-]+)(?::\d+)?$/u.exec(
      configuredModel,
    )?.[1];
  return (
    foundationModel !== undefined &&
    (foundationModel === catalogModel ||
      foundationModel.startsWith(`${catalogModel}-`))
  );
}
