import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Copy, X } from 'lucide-react';
import { useI18n } from './i18n.js';
import { ErrorNotice, useBoard } from './board.js';
import { useState } from 'react';

export function TaskDrawer({
  id,
  siblings,
  onClose,
  children,
}: {
  id: number;
  siblings: number[];
  onClose: () => void;
  children: ReactNode;
}) {
  const tr = useI18n();
  const { openTask } = useBoard();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    heading.current?.focus();
    body.current?.scrollTo(0, 0);
    setCopied(false);
    setError(undefined);
  }, [id]);
  useEffect(() => {
    const element = panel.current!;
    const compact = window.matchMedia('(max-width: 760px)');
    const present = () => {
      if (element.open) element.close();
      element.setAttribute('aria-modal', String(compact.matches));
      if (compact.matches) element.showModal();
      else element.show();
      heading.current?.focus();
    };
    present();
    compact.addEventListener('change', present);
    return () => {
      compact.removeEventListener('change', present);
      element.close();
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog:modal')
      )
        close.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const index = siblings.indexOf(id);
  return (
    <dialog
      ref={panel}
      className="task-drawer"
      aria-labelledby="task-drawer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="task-drawer-header">
        <h2 id="task-drawer-title" ref={heading} tabIndex={-1}>
          {tr('T-{0} · 任务详情', id)}
        </h2>
        <div className="inline">
          <button
            className="icon-button"
            aria-label={tr('上一项任务')}
            disabled={index <= 0}
            onClick={() => openTask(siblings[index - 1]!)}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={tr('下一项任务')}
            disabled={index < 0 || index >= siblings.length - 1}
            onClick={() => openTask(siblings[index + 1]!)}
          >
            <ArrowRight size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={copied ? tr('已复制链接') : tr('复制任务链接')}
            title={copied ? tr('已复制链接') : tr('复制任务链接')}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(location.href);
                setCopied(true);
              } catch (error) {
                setError(error);
              }
            }}
          >
            <Copy size={17} />
          </button>
          <button className="icon-button" aria-label={tr('关闭任务详情')} onClick={onClose}>
            <X size={19} />
          </button>
        </div>
      </header>
      <div className="task-drawer-body" ref={body}>
        <ErrorNotice error={error} />
        {children}
      </div>
    </dialog>
  );
}
