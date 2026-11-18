// QuestionOptions.jsx — the lettered options of one question as a radio group, above the question's
// own answer box. Picking one writes "(b) its words" into that box (the draft stays plain text, so
// Save and the answered tick work as before); typing anything else there unselects it, because the
// choice is read back from the box and never stored. "Other" moves focus to the box and stays
// selected while the box is empty (the one thing kept here), so the click is seen to have worked.
import { useState } from 'react';
import { chosenLetter, optionAnswer } from '../../ui/question-options.js';

export function QuestionOptions({ name, labelledBy, options, value, disabled, onPick, onOther }) {
  const [writing, setWriting] = useState(false);
  const otherLetter = options.find(({ other }) => other)?.letter ?? null;
  const chosen = value.trim() ? chosenLetter(value, options) : writing ? otherLetter : null;
  return (
    <div
      className="claude-options"
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid={`${name}-options`}
    >
      {options.map((option) => (
        <label key={option.letter} className="claude-option">
          <input
            type="radio"
            name={name}
            value={option.letter}
            checked={chosen === option.letter}
            disabled={disabled}
            data-testid={`${name}-option-${option.letter}`}
            onChange={() => {
              setWriting(Boolean(option.other));
              if (option.other) onOther();
              else onPick(optionAnswer(option));
            }}
          />
          <span className="claude-option-letter" aria-hidden="true">
            {option.letter}
          </span>
          <span className="claude-option-text">{option.text}</span>
          {option.recommended && <span className="claude-option-tag">Recommended</span>}
        </label>
      ))}
    </div>
  );
}
