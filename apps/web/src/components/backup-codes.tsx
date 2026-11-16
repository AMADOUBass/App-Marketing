import { Button } from '@ponctua/ui';
import { useTranslation } from 'react-i18next';

/**
 * Shown once, right after they are generated: the server keeps them encrypted and never shows them
 * again. The user can save them as a text file.
 */
export function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();

  function download() {
    const text = [t('twoFactor.backupCodes.fileTitle'), '', ...codes, ''].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ponctua-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm">{t('twoFactor.backupCodes.explain', { count: codes.length })}</p>
      <ol
        aria-label={t('twoFactor.backupCodes.listLabel')}
        className="grid grid-cols-2 gap-2 rounded-md border p-4 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" onClick={download}>
          {t('twoFactor.backupCodes.download')}
        </Button>
        <Button type="button" onClick={onDone}>
          {t('twoFactor.backupCodes.done')}
        </Button>
      </div>
    </div>
  );
}
