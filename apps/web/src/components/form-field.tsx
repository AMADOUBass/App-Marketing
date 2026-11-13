import { Input, Label } from '@ponctua/ui';
import { type ComponentProps, useId } from 'react';

interface FormFieldProps extends Omit<ComponentProps<typeof Input>, 'id'> {
  label: string;
  hint?: string | undefined;
  /** Shown under the field and linked to it, so screen readers read it with the label. */
  error?: string | undefined;
}

/** Labelled input with its hint and error wired through aria-describedby (WCAG 1.3.1, 3.3.1). */
export function FormField({ label, hint, error, ...input }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Moves focus to the first invalid field after a failed submit, which announces its error. */
export function focusFirstInvalid(form: HTMLFormElement): void {
  form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
