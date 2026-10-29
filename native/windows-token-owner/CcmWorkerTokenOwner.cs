using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

// The Worker launches this executable once on startup. It only changes its
// immediate parent process's token default owner to the parent token's user.
internal static class CcmWorkerTokenOwner
{
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const int TokenUser = 1;
    const int TokenOwner = 4;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_OWNER
    {
        public IntPtr Owner;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(
        IntPtr token, int infoClass, IntPtr buffer, uint length, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(
        IntPtr token, int infoClass, ref TOKEN_OWNER owner, uint length);

    static int ParentPid()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new InvalidOperationException("CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());
        try
        {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            bool found = Process32FirstW(snapshot, ref entry);
            while (found)
            {
                if (entry.th32ProcessID == (uint)Process.GetCurrentProcess().Id)
                    return checked((int)entry.th32ParentProcessID);
                found = Process32NextW(snapshot, ref entry);
            }
            throw new InvalidOperationException("Worker parent process could not be resolved.");
        }
        finally { CloseHandle(snapshot); }
    }

    static SecurityIdentifier TokenSid(IntPtr token, int infoClass)
    {
        uint needed = 0;
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out needed);
        if (needed < (uint)IntPtr.Size)
            throw new InvalidOperationException("GetTokenInformation size failed: " + Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, infoClass, buffer, needed, out needed))
                throw new InvalidOperationException("GetTokenInformation failed: " + Marshal.GetLastWin32Error());
            return new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static void Run()
    {
        int pid = ParentPid();
        if (pid <= 0) throw new InvalidOperationException("Invalid parent PID.");
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (process == IntPtr.Zero)
            throw new InvalidOperationException("OpenProcess failed: " + Marshal.GetLastWin32Error());
        try
        {
            IntPtr token;
            if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out token))
                throw new InvalidOperationException("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
            try
            {
                var user = WindowsIdentity.GetCurrent().User;
                if (!TokenSid(token, TokenUser).Equals(user))
                    throw new InvalidOperationException("Worker token user differs from helper token user.");
                if (TokenSid(token, TokenOwner).Equals(user)) return;

                byte[] sid = new byte[user.BinaryLength];
                user.GetBinaryForm(sid, 0);
                IntPtr nativeSid = Marshal.AllocHGlobal(sid.Length);
                try
                {
                    Marshal.Copy(sid, 0, nativeSid, sid.Length);
                    var owner = new TOKEN_OWNER { Owner = nativeSid };
                    if (!SetTokenInformation(token, TokenOwner, ref owner,
                        (uint)Marshal.SizeOf(typeof(TOKEN_OWNER))))
                        throw new InvalidOperationException(
                            "SetTokenInformation(TokenOwner) failed: " + Marshal.GetLastWin32Error());
                }
                finally { Marshal.FreeHGlobal(nativeSid); }
                if (!TokenSid(token, TokenOwner).Equals(user))
                    throw new InvalidOperationException("Token owner verification failed.");
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    static int Main(string[] args)
    {
        if (args.Length != 0)
        {
            Console.Error.WriteLine("CcmWorkerTokenOwner takes no arguments.");
            return 2;
        }
        try { Run(); return 0; }
        catch (Exception error)
        {
            Console.Error.WriteLine("CCM Worker token owner: " + error.Message);
            return 1;
        }
    }
}
