import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class AdminLoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  // bcrypt is deliberately slow; an unbounded password is a cheap way to
  // tie the server up.
  @MaxLength(128)
  password!: string;
}
