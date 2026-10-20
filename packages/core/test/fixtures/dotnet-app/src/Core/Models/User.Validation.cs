namespace Shop.Core.Models;

public partial class User
{
    public bool IsValid() => Email.Contains('@');
}
