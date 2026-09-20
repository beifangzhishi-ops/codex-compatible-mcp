using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

internal static class CcmSandboxRunner
{
    const UInt32 TOKEN_ALL_ACCESS = 0x000F01FF;
    const UInt32 DISABLE_MAX_PRIVILEGE = 0x1;
    const UInt32 LUA_TOKEN = 0x4;
    const UInt32 WRITE_RESTRICTED = 0x8;
    const UInt32 STARTF_USESTDHANDLES = 0x00000100;
    const UInt32 CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const UInt32 INFINITE = 0xFFFFFFFF;
    const UInt32 SE_PRIVILEGE_ENABLED = 0x00000002;
    const Int32 TOKEN_DEFAULT_DACL_CLASS = 6;
    const UInt32 SDDL_REVISION_1 = 1;
    const Int32 TOKEN_GROUPS_CLASS = 2;
    const UInt32 SE_GROUP_LOGON_ID = 0xC0000000;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public UInt32 Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LUID
    {
        public UInt32 LowPart;
        public Int32 HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public UInt32 Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_PRIVILEGES
    {
        public UInt32 PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_DEFAULT_DACL
    {
        public IntPtr DefaultDacl;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public UInt32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public UInt32 dwX;
        public UInt32 dwY;
        public UInt32 dwXSize;
        public UInt32 dwYSize;
        public UInt32 dwXCountChars;
        public UInt32 dwYCountChars;
        public UInt32 dwFillAttribute;
        public UInt32 dwFlags;
        public UInt16 wShowWindow;
        public UInt16 cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public UInt32 dwProcessId;
        public UInt32 dwThreadId;
    }

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern UInt32 WaitForSingleObject(IntPtr hHandle, UInt32 dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out UInt32 lpExitCode);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(Int32 nStdHandle);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string StringSecurityDescriptor,
        UInt32 StringSDRevision,
        out IntPtr SecurityDescriptor,
        out UInt32 SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(
        IntPtr pSecurityDescriptor,
        out bool lpbDaclPresent,
        out IntPtr pDacl,
        out bool lpbDaclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(
        IntPtr ProcessHandle,
        UInt32 DesiredAccess,
        out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(
        IntPtr TokenHandle,
        Int32 TokenInformationClass,
        IntPtr TokenInformation,
        UInt32 TokenInformationLength,
        out UInt32 ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(
        IntPtr ExistingTokenHandle,
        UInt32 Flags,
        UInt32 DisableSidCount,
        IntPtr SidsToDisable,
        UInt32 DeletePrivilegeCount,
        IntPtr PrivilegesToDelete,
        UInt32 RestrictedSidCount,
        [In] SID_AND_ATTRIBUTES[] SidsToRestrict,
        out IntPtr NewTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValue(
        string lpSystemName,
        string lpName,
        out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(
        IntPtr TokenHandle,
        bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState,
        UInt32 BufferLength,
        IntPtr PreviousState,
        IntPtr ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(
        IntPtr TokenHandle,
        Int32 TokenInformationClass,
        ref TOKEN_DEFAULT_DACL TokenInformation,
        UInt32 TokenInformationLength);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(
        IntPtr hToken,
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        UInt32 dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    static Dictionary<string, string> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i + 1 < args.Length; i += 2)
            result[args[i]] = args[i + 1];
        return result;
    }

    static string CapabilitySidForRoot(string root, string profile)
    {
        byte[] digest;
        string sidKey = profile + "|" +
            Path.GetFullPath(root).TrimEnd((char)92).ToUpperInvariant();
        using (var sha = SHA256.Create())
            digest = sha.ComputeHash(Encoding.UTF8.GetBytes(sidKey));

        var sb = new StringBuilder("S-1-5-21");
        for (int i = 0; i < 4; i++)
        {
            UInt32 value = BitConverter.ToUInt32(digest, i * 4);
            sb.Append("-").Append(value);
        }
        return sb.ToString();
    }

    static void EnsureWorkspaceWriteAce(string workspace, SecurityIdentifier sid)
    {
        var info = new DirectoryInfo(workspace);
        if (!info.Exists) throw new DirectoryNotFoundException(workspace);

        var security = info.GetAccessControl(AccessControlSections.Access);
        var rights = FileSystemRights.Modify |
            FileSystemRights.ReadAndExecute |
            FileSystemRights.Synchronize;
        var inheritance = InheritanceFlags.ContainerInherit |
            InheritanceFlags.ObjectInherit;
        var existingRules = security.GetAccessRules(
            true, false, typeof(SecurityIdentifier));
        foreach (AuthorizationRule authorizationRule in existingRules)
        {
            var existing = authorizationRule as FileSystemAccessRule;
            if (existing == null || existing.AccessControlType != AccessControlType.Allow)
                continue;
            var existingSid = existing.IdentityReference as SecurityIdentifier;
            if (existingSid == null || !existingSid.Equals(sid))
                continue;
            if ((existing.FileSystemRights & rights) != rights)
                continue;
            if ((existing.InheritanceFlags & inheritance) != inheritance)
                continue;
            if (existing.PropagationFlags != PropagationFlags.None)
                continue;
            return;
        }
        var rule = new FileSystemAccessRule(
            sid,
            rights,
            inheritance,
            PropagationFlags.None,
            AccessControlType.Allow);
        security.AddAccessRule(rule);
        info.SetAccessControl(security);
    }

    static IntPtr SidToNative(SecurityIdentifier sid)
    {
        byte[] bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, ptr, bytes.Length);
        return ptr;
    }

    static SecurityIdentifier GetLogonSid(IntPtr token)
    {
        UInt32 needed = 0;
        GetTokenInformation(token, TOKEN_GROUPS_CLASS, IntPtr.Zero, 0, out needed);
        if (needed == 0)
            throw new InvalidOperationException("TokenGroups size query failed: " +
                Marshal.GetLastWin32Error());

        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, TOKEN_GROUPS_CLASS, buffer, needed, out needed))
                throw new InvalidOperationException("GetTokenInformation(TokenGroups) failed: " +
                    Marshal.GetLastWin32Error());

            int count = Marshal.ReadInt32(buffer);
            int offset = IntPtr.Size == 8 ? 8 : 4;
            int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (int i = 0; i < count; i++)
            {
                IntPtr entryPtr = IntPtr.Add(buffer, offset + i * stride);
                var entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                    entryPtr, typeof(SID_AND_ATTRIBUTES));
                if ((entry.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
                    return new SecurityIdentifier(entry.Sid);
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        throw new InvalidOperationException("Logon SID not present on token.");
    }

    static void SetDefaultDacl(IntPtr token, SecurityIdentifier[] sids)
    {
        var sddl = new StringBuilder("D:");
        foreach (SecurityIdentifier sid in sids)
            sddl.Append("(A;;GA;;;").Append(sid.Value).Append(")");

        IntPtr descriptor = IntPtr.Zero;
        UInt32 descriptorSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(
            sddl.ToString(), SDDL_REVISION_1, out descriptor, out descriptorSize))
            throw new InvalidOperationException(
                "ConvertStringSecurityDescriptor failed: " + Marshal.GetLastWin32Error());
        try
        {
            bool present, defaulted;
            IntPtr dacl;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present)
                throw new InvalidOperationException(
                    "GetSecurityDescriptorDacl failed: " + Marshal.GetLastWin32Error());
            var info = new TOKEN_DEFAULT_DACL();
            info.DefaultDacl = dacl;
            if (!SetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, ref info,
                (UInt32)Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL))))
                throw new InvalidOperationException(
                    "SetTokenInformation(TokenDefaultDacl) failed: " + Marshal.GetLastWin32Error());
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    static void EnableChangeNotifyPrivilege(IntPtr token)
    {
        LUID luid;
        if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out luid))
            throw new InvalidOperationException(
                "LookupPrivilegeValue failed: " + Marshal.GetLastWin32Error());
        var tp = new TOKEN_PRIVILEGES();
        tp.PrivilegeCount = 1;
        tp.Privileges = new LUID_AND_ATTRIBUTES();
        tp.Privileges.Luid = luid;
        tp.Privileges.Attributes = SE_PRIVILEGE_ENABLED;
        if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero))
            throw new InvalidOperationException(
                "AdjustTokenPrivileges failed: " + Marshal.GetLastWin32Error());
        int err = Marshal.GetLastWin32Error();
        if (err != 0)
            throw new InvalidOperationException("AdjustTokenPrivileges error: " + err);
    }

    static string QuoteArg(string value)
    {
        char slash = (char)92;
        char quote = (char)34;
        if (value.Length == 0) return new string(quote, 2);
        bool needs = value.IndexOf(' ') >= 0 ||
            value.IndexOf((char)9) >= 0 ||
            value.IndexOf(quote) >= 0;
        if (!needs) return value;

        var sb = new StringBuilder();
        sb.Append(quote);
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == slash) { slashes++; continue; }
            if (c == quote)
            {
                sb.Append(slash, slashes * 2 + 1).Append(quote);
                slashes = 0;
                continue;
            }
            sb.Append(slash, slashes).Append(c);
            slashes = 0;
        }
        sb.Append(slash, slashes * 2).Append(quote);
        return sb.ToString();
    }

    static string BuildCommandLine(string shell, string command)
    {
        string name = Path.GetFileName(shell).ToLowerInvariant();
        var parts = new List<string>();
        parts.Add(shell);
        if (name == "cmd.exe" || name == "cmd")
        {
            parts.Add("/d"); parts.Add("/s"); parts.Add("/c"); parts.Add(command);
        }
        else if (name.Contains("powershell") || name == "pwsh.exe" || name == "pwsh")
        {
            parts.Add("-NoLogo"); parts.Add("-NoProfile");
            parts.Add("-NonInteractive"); parts.Add("-Command"); parts.Add(command);
        }
        else
        {
            parts.Add("-lc"); parts.Add(command);
        }
        var quoted = new List<string>();
        foreach (string part in parts) quoted.Add(QuoteArg(part));
        return string.Join(" ", quoted.ToArray());
    }

    static int Fail(string message)
    {
        Console.Error.WriteLine("CCM sandbox: " + message);
        return 125;
    }

    public static int Main(string[] argv)
    {
        var args = ParseArgs(argv);
        string profile, workspace, cwd, shell, command;
        if (!args.TryGetValue("--profile", out profile) ||
            !args.TryGetValue("--workspace", out workspace) ||
            !args.TryGetValue("--cwd", out cwd) ||
            !args.TryGetValue("--shell", out shell) ||
            !args.TryGetValue("--command", out command))
            return Fail("missing required arguments");

        if (profile != "read-only" && profile != "workspace-write")
            return Fail("unsupported permission profile: " + profile);

        workspace = Path.GetFullPath(workspace);
        cwd = Path.GetFullPath(cwd);
        var capabilitySid = new SecurityIdentifier(CapabilitySidForRoot(workspace, profile));

        if (profile == "workspace-write")
            EnsureWorkspaceWriteAce(workspace, capabilitySid);
        IntPtr baseToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr sidPtr = IntPtr.Zero;
        IntPtr logonSidPtr = IntPtr.Zero;
        IntPtr worldSidPtr = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out baseToken))
                return Fail("OpenProcessToken failed: " + Marshal.GetLastWin32Error());

            var logonSid = GetLogonSid(baseToken);
            var worldSid = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
            sidPtr = SidToNative(capabilitySid);
            logonSidPtr = SidToNative(logonSid);
            worldSidPtr = SidToNative(worldSid);
            var restricted = new SID_AND_ATTRIBUTES[3];
            restricted[0].Sid = sidPtr;
            restricted[0].Attributes = 0;
            restricted[1].Sid = logonSidPtr;
            restricted[1].Attributes = 0;
            restricted[2].Sid = worldSidPtr;
            restricted[2].Attributes = 0;

            UInt32 flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
            if (!CreateRestrictedToken(
                baseToken, flags, 0, IntPtr.Zero, 0, IntPtr.Zero,
                (UInt32)restricted.Length, restricted, out restrictedToken))
                return Fail("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());

            SetDefaultDacl(restrictedToken, new SecurityIdentifier[] {
                logonSid, worldSid, capabilitySid
            });
            EnableChangeNotifyPrivilege(restrictedToken);

            var si = new STARTUPINFO();
            si.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(-10);
            si.hStdOutput = GetStdHandle(-11);
            si.hStdError = GetStdHandle(-12);

            var cmdline = new StringBuilder(BuildCommandLine(shell, command));
            if (!CreateProcessAsUser(
                restrictedToken, null, cmdline, IntPtr.Zero, IntPtr.Zero,
                true, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi))
                return Fail("CreateProcessAsUserW failed: " + Marshal.GetLastWin32Error());

            WaitForSingleObject(pi.hProcess, INFINITE);
            UInt32 exitCode;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode))
                return Fail("GetExitCodeProcess failed: " + Marshal.GetLastWin32Error());
            return unchecked((int)exitCode);
        }
        catch (Exception ex)
        {
            return Fail(ex.GetType().Name + ": " + ex.Message);
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (baseToken != IntPtr.Zero) CloseHandle(baseToken);
            if (worldSidPtr != IntPtr.Zero) Marshal.FreeHGlobal(worldSidPtr);
            if (logonSidPtr != IntPtr.Zero) Marshal.FreeHGlobal(logonSidPtr);
            if (sidPtr != IntPtr.Zero) Marshal.FreeHGlobal(sidPtr);
        }
    }
}
