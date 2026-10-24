using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// Only the application-owned browser session travels through stdin/stdout.
// Never accepts file paths, commands, user credentials as arguments, or logs
// plaintext. DPAPI binds ciphertext to this Windows user and exact profile.
internal static class GuardianProfileVault {
    private static int Main(string[] args) {
        try {
            if (args.Length != 2 || (args[0] != "protect" && args[0] != "unprotect") ||
                !Regex.IsMatch(args[1], "^[a-f0-9]{64}$")) return 2;
            string input = Console.In.ReadToEnd();
            if (input.Length > 12 * 1024 * 1024) return 3;
            byte[] bytes = Convert.FromBase64String(input);
            if (bytes.Length > 8 * 1024 * 1024) return 3;
            byte[] entropy = Encoding.UTF8.GetBytes("DoudianGuardian-profile-session-v1:" + args[1]);
            byte[] result = args[0] == "protect"
                ? ProtectedData.Protect(bytes, entropy, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(bytes, entropy, DataProtectionScope.CurrentUser);
            Console.Out.Write(Convert.ToBase64String(result));
            Array.Clear(bytes, 0, bytes.Length);
            Array.Clear(result, 0, result.Length);
            return 0;
        } catch {
            Console.Error.Write("PROFILE_VAULT_UNAVAILABLE");
            return 1;
        }
    }
}
