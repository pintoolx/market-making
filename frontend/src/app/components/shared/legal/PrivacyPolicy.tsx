export default function PrivacyPolicy() {
  return (
    <>
      <p>This policy explains what information PinTool handles when you create strategies, provide liquidity or trade.</p>

      <h2>1. Information we collect</h2>
      <ul>
        <li><strong>Login details.</strong> Sign-in is provided by Privy. Depending on how you log in, Privy processes your email address or your wallet address. PinTool receives your account identifier and public wallet address.</li>
        <li><strong>Public wallet activity.</strong> Transactions you sign, such as approving tokens or adding liquidity to an Aqua strategy, are recorded on a public blockchain.</li>
        <li><strong>Profile details.</strong> The photo, display name, bio and X handle you add are saved in your browser. If you publish a strategy, the profile details attached to it may appear publicly.</li>
        <li><strong>Strategy and liquidity records.</strong> Public strategy versions, wallet addresses, encrypted policy envelopes, liquidity setup records and execution activity are sent to PinTool services or recorded onchain as needed to provide the product.</li>
      </ul>
      <p>We <strong>never</strong> collect or store your private keys or seed phrases.</p>

      <h2>2. Confidential strategy rules and liquidity limits</h2>
      <p>PinTool encrypts confidential strategy rules and liquidity limits in your browser before sending them to a Chainlink Confidential Workflow. The public strategy version and resulting execution authorization do not include those plaintext inputs. The workflow processes decrypted values to evaluate whether execution is allowed.</p>

      <h2>3. How we use information</h2>
      <ul>
        <li>To sign you in and show your strategies, liquidity and account details.</li>
        <li>To publish strategy versions, evaluate private rules and prepare transactions you choose to sign.</li>
      </ul>
      <p>We do not sell your information and we do not use analytics or advertising trackers.</p>

      <h2>4. Third parties</h2>
      <p>PinTool relies on services that process data under their own policies: Privy for authentication, blockchain RPC providers for reading and sending transactions, and protocols such as 1inch Aqua and Chainlink when you use features built on them.</p>

      <h2>5. Your choices</h2>
      <ul>
        <li>You can log out at any time from your profile.</li>
        <li>You can clear locally saved drafts and profile details by clearing this site&apos;s data in your browser.</li>
        <li>Onchain transactions cannot be deleted by PinTool or anyone else.</li>
      </ul>

      <h2>6. Changes to this policy</h2>
      <p>We will update this page when the product changes how information is handled, and change the date above.</p>

      <h2>7. Contact</h2>
      <p>Questions about this policy: reach us on X at <a href="https://x.com/PinToolX" target="_blank" rel="noopener noreferrer">@PinToolX</a>.</p>
    </>
  );
}
