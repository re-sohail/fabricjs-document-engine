import { classRegistry } from 'fabric';
import { DocumentEngineError } from '../engine/errors';

export interface CustomObjectDefinition {
  fabricClass: { type: string; fromObject?: unknown };
  properties?: string[];
}

export interface ObjectRegistry {
  register(definition: CustomObjectDefinition): void;
  propertiesToInclude(): string[];
  findUnknownTypes(types: Iterable<string>): string[];
}

export function createObjectRegistry(initialDefinitions: readonly CustomObjectDefinition[] = []): ObjectRegistry {
  // `name` is the label a layers panel shows. Fabric does not save it on its own.
  const extraProperties = new Set<string>(['id', 'name']);

  function register(definition: CustomObjectDefinition): void {
    const { fabricClass } = definition;
    if (typeof fabricClass?.type !== 'string' || fabricClass.type.length === 0) {
      throw new DocumentEngineError(
        'INVALID_CUSTOM_OBJECT',
        'A custom object class needs a static "type" string, for example: static type = "Sticker"',
      );
    }
    if (typeof fabricClass.fromObject !== 'function') {
      throw new DocumentEngineError(
        'INVALID_CUSTOM_OBJECT',
        `Custom object "${fabricClass.type}" must extend a Fabric class so it has a static fromObject method`,
      );
    }
    classRegistry.setClass(fabricClass);
    for (const property of definition.properties ?? []) extraProperties.add(property);
  }

  initialDefinitions.forEach(register);

  return {
    register,
    propertiesToInclude: () => [...extraProperties],
    findUnknownTypes: (types) => [...types].filter((type) => !classRegistry.has(type)),
  };
}
