class SchemaValidationError extends Error {
  constructor(errors) {
    super(`JSON Schema validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(value, type) {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isObject(value);
    case 'string':
      return typeof value === 'string';
    default:
      throw new Error(`unsupported JSON Schema type: ${type}`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function equalValue(left, right) {
  return canonicalValue(left) === canonicalValue(right);
}

function resolveLocalRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported non-local schema reference: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, segment) => {
      if (!isObject(current) || !(segment in current)) {
        throw new Error(`unresolved schema reference: ${ref}`);
      }
      return current[segment];
    }, rootSchema);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validUri(value) {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validateFormat(value, format) {
  if (format === 'date') return validDate(value);
  if (format === 'date-time') return validDateTime(value);
  if (format === 'uri') return validUri(value);
  throw new Error(`unsupported JSON Schema format: ${format}`);
}

function childPath(parent, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function collectErrors(value, schema, rootSchema, instancePath) {
  if (!isObject(schema)) throw new Error(`invalid schema node at ${instancePath}`);
  if (schema.$ref) {
    return collectErrors(value, resolveLocalRef(rootSchema, schema.$ref), rootSchema, instancePath);
  }

  const errors = [];
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(
      (candidate) => collectErrors(value, candidate, rootSchema, instancePath).length === 0
    );
    if (!matches) errors.push(`${instancePath} must match one anyOf branch`);
  }
  if ('const' in schema && !equalValue(value, schema.const)) {
    errors.push(`${instancePath} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equalValue(value, candidate))) {
    errors.push(`${instancePath} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${instancePath} must be ${schema.type}`);
    return errors;
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${instancePath} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${instancePath} must match ${schema.pattern}`);
    }
    if (schema.format && !validateFormat(value, schema.format)) {
      errors.push(`${instancePath} must use ${schema.format} format`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(schema.minimum) && value < schema.minimum) {
    errors.push(`${instancePath} must be at least ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${instancePath} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems) {
      const canonicalItems = value.map(canonicalValue);
      if (new Set(canonicalItems).size !== canonicalItems.length) {
        errors.push(`${instancePath} must contain unique items`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...collectErrors(item, schema.items, rootSchema, `${instancePath}[${index}]`));
      });
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const required of schema.required || []) {
      if (!(required in value)) errors.push(`${childPath(instancePath, required)} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${childPath(instancePath, key)} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...collectErrors(value[key], childSchema, rootSchema, childPath(instancePath, key)));
      }
    }
  }

  return errors;
}

export function validateJsonSchema(value, schema) {
  const errors = collectErrors(value, schema, schema, '$');
  if (errors.length > 0) throw new SchemaValidationError(errors);
  return true;
}

export { SchemaValidationError };
