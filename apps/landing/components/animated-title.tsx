export function AnimatedTitle({ text, className = "" }: { text: string; className?: string }) {
  return (
    <h1 className={className} aria-label={text}>
      {text.split("").map((char, i) => (
        <span
          key={`${char}-${i}`}
          className="inline-block"
          style={{
            animation: `title-settle 0.5s cubic-bezier(0.25, 1, 0.5, 1) ${i * 0.04}s both`,
          }}
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </h1>
  )
}
