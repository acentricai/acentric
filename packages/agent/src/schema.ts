// The schemas an agent's configuration, inputs and tool arguments are
// validated against. Any library that implements Standard Schema
// (https://standardschema.dev) works: Zod, Valibot, ArkType and others. The
// interfaces are copied as they are from @standard-schema/spec 1.1.0, as the
// spec recommends, so no schema library is a dependency.
//
// A tool's schema is also asked for its JSON Schema, which is what a provider
// is sent: that is Standard JSON Schema, from the same spec.

/** The Standard Typed interface. This is a base type extended by other specs. */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  /** The Standard properties. */
  readonly '~standard': StandardTypedV1.Props<Input, Output>;
}

export declare namespace StandardTypedV1 {
  /** The Standard Typed properties interface. */
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The Standard Typed types interface. */
  interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Typed. */
  type InferInput<Schema extends StandardTypedV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Typed. */
  type InferOutput<Schema extends StandardTypedV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/** The Standard Schema interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    /** Validates unknown input values. */
    readonly validate: (
      value: unknown,
      options?: StandardSchemaV1.Options | undefined,
    ) => Result<Output> | Promise<Result<Output>>;
  }

  /** The result interface of the validate function. */
  type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** A falsy value for `issues` indicates success. */
    readonly issues?: undefined;
  }

  interface Options {
    /** Explicit support for additional vendor-specific parameters, if needed. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  /** The result interface if validation fails. */
  interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** The issue interface of the failure output. */
  interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}

  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;

  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

/** The Standard JSON Schema interface. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  /** The Standard JSON Schema properties. */
  readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
}

export declare namespace StandardJSONSchemaV1 {
  /** The Standard JSON Schema properties interface. */
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    /** Methods for generating the input/output JSON Schema. */
    readonly jsonSchema: StandardJSONSchemaV1.Converter;
  }

  /** The Standard JSON Schema converter interface. */
  interface Converter {
    /** Converts the input type to JSON Schema. May throw if conversion is not supported. */
    readonly input: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>;
    /** Converts the output type to JSON Schema. May throw if conversion is not supported. */
    readonly output: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>;
  }

  /** The target version of the generated JSON Schema. */
  type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string);

  /** The options for the input/output methods. */
  interface Options {
    /** Specifies the target version of the generated JSON Schema. */
    readonly target: Target;
    /** Explicit support for additional vendor-specific parameters, if needed. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}

  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;

  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

// What this package asks of a schema.

/** A schema a value is validated against. `Output` is what validation returns. */
export type Schema<Output = unknown, Input = unknown> = StandardSchemaV1<Input, Output>;

/**
 * The schema of a tool's arguments. It validates them, and it also gives
 * their JSON Schema, which is what the model is sent.
 */
export type ToolSchema<Output = unknown, Input = unknown> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/** What a schema returns once a value has passed it. */
export type OutputOf<S extends StandardTypedV1> = StandardTypedV1.InferOutput<S>;

/** What a schema takes: the value as it is given, before defaults are filled in. */
export type InputOf<S extends StandardTypedV1> = StandardTypedV1.InferInput<S>;
