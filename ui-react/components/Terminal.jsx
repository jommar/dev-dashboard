import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export function Terminal({
  id,
  getLog,
  defaultTail,
  onState,
  follow = true,
  active = true,
  expose,
}) {
  const element = useRef(null);
  const requestGeneration = useRef(0);
  const pending = useRef(null);
  const [lines, setLines] = useState(defaultTail);
  const refresh = useCallback(async () => {
    const generation = requestGeneration.current;
    if (!element.current || pending.current?.generation === generation)
      return pending.current?.promise;
    const requestedLines = lines;
    onState({
      state: 'pending',
      message: element.current.textContent ? 'Updating output…' : 'Loading output…',
    });
    const promise = (async () => {
      try {
        const text = await getLog(id, requestedLines);
        if (generation !== requestGeneration.current || !element.current) return;
        const node = element.current;
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 12;
        const scrollTop = node.scrollTop;
        if (node.textContent !== text) node.textContent = text;
        node.scrollTop = follow && atBottom ? node.scrollHeight : scrollTop;
        onState({
          state: 'success',
          message:
            requestedLines === 0
              ? 'All retained output · older history may be unavailable'
              : `Last ${defaultTail} lines`,
        });
      } catch (error) {
        if (generation === requestGeneration.current)
          onState({
            state: 'error',
            message: `${error.message}. Keeping last output. Use Refresh log to retry.`,
          });
      } finally {
        if (pending.current?.generation === generation) pending.current = null;
      }
    })();
    pending.current = { generation, promise };
    return promise;
  }, [defaultTail, follow, getLog, id, lines, onState]);
  useEffect(() => {
    if (active && activeElementVisible(element.current)) refresh();
  }, [active, refresh]);
  useEffect(() => {
    if (follow && element.current) element.current.scrollTop = element.current.scrollHeight;
  }, [follow]);
  useImperativeHandle(
    expose,
    () => ({
      refresh,
      toggleLines() {
        requestGeneration.current++;
        setLines((value) => (value === 0 ? defaultTail : 0));
      },
    }),
    [defaultTail, refresh],
  );
  return (
    <pre
      ref={element}
      id={`log-${id}`}
      className="log"
      tabIndex={0}
      aria-label={`${id} service output`}
      data-service={id}
      data-testid={`log-${id}`}
    />
  );
}

function activeElementVisible(element) {
  return !!element && !element.closest('[hidden]');
}
