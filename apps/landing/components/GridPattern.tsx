"use client"

import { useId, type SVGProps, type ReactNode } from "react"

interface GridPatternProps extends SVGProps<SVGSVGElement> {
    size?: number
    offsetX?: number
    offsetY?: number
    children?: ReactNode
}

interface GridBlockProps extends SVGProps<SVGRectElement> {
    row: number
    column: number
}

export function GridBlock({ row, column, className, ...props }: GridBlockProps) {
    return (
        <rect
            width="100%"
            height="100%"
            x={0}
            y={0}
            transform={`translate(${column}, ${row})`}
            className={className}
            {...props}
        />
    )
}

export function GridPattern({
    size = 64,
    offsetX = 0,
    offsetY = 0,
    className,
    children,
    ...props
}: GridPatternProps) {
    const id = useId()

    return (
        <svg className={className} {...props}>
            <defs>
                <pattern
                    id={id}
                    viewBox="0 0 1 1"
                    width={size}
                    height={size}
                    patternUnits="userSpaceOnUse"
                    x={offsetX}
                    y={offsetY}
                >
                    <line x1="0" y1="0" x2="0" y2="1" className="stroke-inherit" />
                    <line x1="0" y1="0" x2="1" y2="0" className="stroke-inherit" />
                </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${id})`} />
            <svg x={offsetX} y={offsetY} className="overflow-visible">
                {children}
            </svg>
        </svg>
    )
}
