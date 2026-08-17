import type { Metadata, Viewport } from "next"
import { JetBrains_Mono } from "next/font/google"
import "./globals.css"

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  title: "track3 | Memory Layer for AI Agents",
  description:
    "Persistent, graph-native memory infrastructure for AI agents. Emotional awareness, adaptive retrieval, and temporal versioning in one unified API.",
  keywords: [
    "AI memory",
    "agent memory",
    "persistent memory",
    "graph database",
    "vector search",
    "LLM infrastructure",
    "AI agents",
    "memory layer",
  ],
  authors: [{ name: "track3" }],
  creator: "track3",
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="font-mono antialiased">
        {children}
      </body>
    </html>
  )
}
