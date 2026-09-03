import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";

const ELAPSED_TIME_UPDATE_INTERVAL_MS = 100;

interface ElapsedTimeProps extends Omit<
  HTMLAttributes<HTMLTimeElement>,
  "children"
> {
  startTime: number;
  endTime?: number | undefined;
  children: (elapsedTime: number) => ReactNode;
}

function ElapsedTime({
  startTime,
  endTime,
  children,
  ...rest
}: ElapsedTimeProps) {
  const [currentTime, setCurrentTime] = useState(() => {
    return Date.now();
  });

  useEffect(() => {
    if (endTime !== undefined) {
      return;
    }
    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, ELAPSED_TIME_UPDATE_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [endTime]);

  const elapsedTime = Math.max(0, (endTime ?? currentTime) - startTime);

  return (
    <time dateTime={`PT${elapsedTime / 1000}S`} {...rest}>
      {children(elapsedTime)}
    </time>
  );
}

export { ElapsedTime, type ElapsedTimeProps };
