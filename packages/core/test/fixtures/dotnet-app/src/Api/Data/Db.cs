namespace Shop.Api.Data;

internal static class Db
{
    public const string Fallback = "Server=localhost;Database=shop;User Id=sa;Password=fixture-pass-123;";

    public static string Describe(string password) { var Password = password; return Password; }
}
