import { useId, useRef, type KeyboardEvent } from 'react';
import styles from '../Insights.module.scss';

interface SegmentedProps<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  renderOption: (value: T) => string;
  small?: boolean;
}

/** Radio-group segmented control (arrow keys move and select), as on Cache & Usage. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  renderOption,
  small = false,
}: SegmentedProps<T>) {
  const labelId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const next = options[(index + options.length) % options.length];
    onChange(next);
    refs.current[options.indexOf(next)]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = options.indexOf(value);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      select(current + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(current - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className={`${styles.segmented} ${small ? styles.segmentedSmall : ''}`}
      onKeyDown={handleKeyDown}
    >
      <span id={labelId} className={styles.srOnly}>
        {label}
      </span>
      {options.map((option, index) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={checked ? styles.segmentActive : styles.segment}
            onClick={() => onChange(option)}
          >
            {renderOption(option)}
          </button>
        );
      })}
    </div>
  );
}
