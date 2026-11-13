import { Card, CardContent, CardHeader } from '@ponctua/ui';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Replaces a form once it has done its job ("check your inbox", "password changed"). The heading
 * takes focus so screen readers announce the new state (WCAG 4.1.3).
 */
export function OutcomePanel({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <Card>
      <CardHeader>
        <h2
          ref={heading}
          tabIndex={-1}
          className={`text-lg font-semibold outline-none ${tone === 'error' ? 'text-destructive' : ''}`}
        >
          {title}
        </h2>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}

export const textLinkClass = 'font-medium underline underline-offset-4';
