import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { NavigationProvider } from "./contexts/NavigationContext";
import { AuthProvider } from "./contexts/AuthContext";
import SolanaWalletProvider from "./providers/WalletProvider";
import ToastProviderWrapper from "./providers/ToastProvider";
import InviteCodeModal from "./components/shared/InviteCodeModal";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PinTool - Automated Trading Strategies",
  description: "Create and discover automated trading strategies with PinTool's visual workflow builder and marketplace.",
  keywords: ["trading", "automation", "strategies", "workflow", "marketplace"],
  authors: [{ name: "PinTool Team" }],
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable}`} suppressHydrationWarning>
        <SolanaWalletProvider>
          <AuthProvider>
            <InviteCodeModal />
            <NavigationProvider>
              <ToastProviderWrapper>
                {children}
              </ToastProviderWrapper>
            </NavigationProvider>
          </AuthProvider>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
