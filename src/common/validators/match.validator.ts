import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

function constraintName(args: ValidationArguments): string | undefined {
  const [raw] = args.constraints as unknown[];
  return typeof raw === 'string' ? raw : undefined;
}

export function Match(property: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'match',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const relatedPropertyName = constraintName(args);
          if (!relatedPropertyName) return false;
          const relatedValue = (args.object as Record<string, unknown>)[
            relatedPropertyName
          ];
          return value === relatedValue;
        },
        defaultMessage(args: ValidationArguments) {
          const relatedPropertyName = constraintName(args) ?? property;
          return `${propertyName} must match ${relatedPropertyName}`;
        },
      },
    });
  };
}
